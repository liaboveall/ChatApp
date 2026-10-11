import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { startEdit } from '../sync/compose.ts'
import { setDraft, useDrafts } from '../sync/drafts.ts'
import { makeMessage, uuid } from '../sync/fixtures.ts'
import { type PendingMessage, useOutbox } from '../sync/outbox.ts'
import { syncUi, useSyncUi } from '../sync/state.ts'
import { clearClientStores } from '../sync/stores.ts'
import type { SyncScope } from '../sync/types.ts'
import { Persistence } from './persistence.ts'
import { type DraftRecord, draftKey, keyOf, type QueuedRecord, queuedKey } from './records.ts'
import { type Backend, OfflineStore } from './store.ts'

const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const C1 = uuid(1)
const C2 = uuid(2)
const M1 = uuid(11)
const M2 = uuid(12)

const scopeOf = (patch: Partial<SyncScope> = {}): SyncScope => ({
  userId: 'user-a',
  authEpoch: 3,
  restoreEpoch: 'r1',
  generation: 1,
  ...patch,
})

function memoryBackend(initial: Array<[string, unknown]> = []) {
  const data = new Map<string, unknown>(initial)
  const log: string[] = []
  const backend: Backend = {
    entries: async () => [...data.entries()],
    set: async (key, value) => {
      log.push(`set ${key}`)
      data.set(key, structuredClone(value))
    },
    delete: async (keys) => {
      for (const key of keys) {
        log.push(`delete ${key}`)
        data.delete(key)
      }
    },
    clear: async () => {
      log.push('clear')
      data.clear()
    },
  }
  return { backend, data, log }
}

const draftRecord = (patch: Partial<DraftRecord> = {}): DraftRecord => ({
  kind: 'draft',
  userId: 'user-a',
  authEpoch: 3,
  restoreEpoch: 'r1',
  updatedAt: NOW - HOUR,
  conversationId: C1,
  membershipId: M1,
  text: '上次没发的',
  ...patch,
})
const queuedRecord = (patch: Partial<QueuedRecord> = {}): QueuedRecord => ({
  kind: 'queued',
  userId: 'user-a',
  authEpoch: 3,
  restoreEpoch: 'r1',
  updatedAt: NOW - HOUR,
  conversationId: C1,
  membershipId: M1,
  clientId: uuid(900),
  body: '离线时写的',
  replyToId: null,
  createdAt: new Date(NOW - HOUR).toISOString(),
  state: 'offline',
  error: null,
  ...patch,
})
const entries = (...records: Array<DraftRecord | QueuedRecord>) =>
  records.map((record) => [keyOf(record), record] as [string, unknown])

function setup(
  options: {
    disk?: Array<[string, unknown]>
    memberships?: Record<string, string>
    scope?: SyncScope
  } = {},
) {
  const memory = memoryBackend(options.disk)
  const current: { scope: SyncScope | null; now: number } = {
    scope: options.scope ?? scopeOf(),
    now: NOW,
  }
  const memberships: Record<string, string> = options.memberships ?? { [C1]: M1, [C2]: M2 }
  const restored: PendingMessage[][] = []
  const persistence = new Persistence({
    store: new OfflineStore(memory.backend, () => current.now),
    outbox: { restore: (messages) => restored.push(messages) },
    scope: () => current.scope,
    membershipOf: (id) => memberships[id],
    now: () => current.now,
    debounceMs: 400,
  })
  const stop = persistence.watch()
  /** Puts back the last visit for the scope the engine serves (a scope is told apart by identity, never by content). */
  const restoreNow = async () => {
    if (current.scope === null) throw new Error('no scope')
    await persistence.restore(current.scope)
  }
  return { persistence, memory, current, memberships, restored, stop, restoreNow }
}

const pending = (patch: Partial<PendingMessage> = {}): PendingMessage => ({
  clientId: uuid(901),
  conversationId: C1,
  membershipId: M1,
  body: '正在发',
  replyToId: null,
  quote: null,
  createdAt: new Date(NOW - 1000).toISOString(),
  state: 'sending',
  error: null,
  ...patch,
})
const putPending = (...messages: PendingMessage[]) =>
  useOutbox.setState({
    byConversation: messages.reduce<Record<string, PendingMessage[]>>((all, message) => {
      all[message.conversationId] = [...(all[message.conversationId] ?? []), message]
      return all
    }, {}),
  })

beforeEach(() => {
  vi.useFakeTimers()
  clearClientStores()
  syncUi.reset()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  clearClientStores()
})

describe('before the last visit has been put back', () => {
  test('nothing is written and nothing is deleted, however the stores change', async () => {
    const kept = draftRecord()
    const { memory, stop } = setup({ disk: entries(kept) })
    setDraft(C2, '新打的字')
    putPending(pending())
    await vi.advanceTimersByTimeAsync(5000)
    expect(memory.log).toEqual([])
    expect(memory.data.size).toBe(1)
    stop()
  })
})

describe('putting back the last visit', () => {
  test('a draft returns to its field when the membership is the same, and does not overwrite what was typed since', async () => {
    const { restoreNow, stop } = setup({
      disk: entries(
        draftRecord(),
        draftRecord({ conversationId: C2, membershipId: M2, text: '旧的' }),
      ),
    })
    setDraft(C2, '刚打的')
    await restoreNow()
    expect(useDrafts.getState().byConversation).toEqual({ [C1]: '上次没发的', [C2]: '刚打的' })
    stop()
  })

  test('a draft written under another membership is not put into the new one, and is deleted', async () => {
    const { restoreNow, memory, stop } = setup({
      disk: entries(draftRecord({ membershipId: uuid(99) })),
    })
    await restoreNow()
    expect(useDrafts.getState().byConversation).toEqual({})
    expect(memory.data.size).toBe(0)
    stop()
  })

  test('records of other accounts and generations are deleted without being read back', async () => {
    const { restoreNow, memory, stop } = setup({
      disk: entries(
        draftRecord({ userId: 'user-b' }),
        draftRecord({ conversationId: C2, membershipId: M2, authEpoch: 2 }),
        queuedRecord({ restoreEpoch: 'r0' }),
      ),
    })
    await restoreNow()
    expect(memory.data.size).toBe(0)
    expect(useDrafts.getState().byConversation).toEqual({})
    stop()
  })

  test('waiting messages go back to the outbox in a state that matches what they are', async () => {
    const waiting = queuedRecord({ clientId: uuid(910) })
    const ancient = queuedRecord({
      clientId: uuid(911),
      createdAt: new Date(NOW - 30 * HOUR).toISOString(),
      updatedAt: NOW - 30 * HOUR,
    })
    const refused = queuedRecord({ clientId: uuid(912), state: 'failed', error: 'FORBIDDEN' })
    const ended = queuedRecord({ clientId: uuid(913), membershipId: uuid(99), replyToId: uuid(55) })
    const gone = queuedRecord({
      clientId: uuid(914),
      conversationId: uuid(77),
      membershipId: uuid(98),
    })
    const { restoreNow, memory, restored, stop } = setup({
      disk: entries(waiting, ancient, refused, ended, gone),
    })
    await restoreNow()

    expect(restored).toHaveLength(1)
    const byId = Object.fromEntries((restored[0] ?? []).map((m) => [m.clientId, m]))
    expect(byId[waiting.clientId]).toMatchObject({
      state: 'offline',
      error: null,
      body: '离线时写的',
    })
    expect(byId[ancient.clientId]).toMatchObject({ state: 'failed', error: 'QUEUE_EXPIRED' })
    expect(byId[refused.clientId]).toMatchObject({ state: 'failed', error: 'FORBIDDEN' })
    // Written under a membership that has ended: kept for the person, but it no longer answers anything.
    expect(byId[ended.clientId]).toMatchObject({
      state: 'failed',
      error: 'MEMBERSHIP_CHANGED',
      replyToId: null,
    })
    // A conversation the person is not in any more: nowhere to show it, and the record goes.
    expect(byId[gone.clientId]).toBeUndefined()
    expect(memory.data.has(queuedKey('user-a', gone.clientId))).toBe(false)
    // No quote of anybody else's words was ever kept, so none comes back.
    expect(Object.values(byId).every((m) => m.quote === null)).toBe(true)
    stop()
  })

  test('starting the page does not renew the seven days of what was kept', async () => {
    const old = draftRecord({ updatedAt: NOW - 6 * DAY })
    const { restoreNow, memory, stop } = setup({ disk: entries(old) })
    await restoreNow()
    await vi.advanceTimersByTimeAsync(5000)
    expect(memory.log).toEqual([])
    expect((memory.data.get(keyOf(old)) as DraftRecord).updatedAt).toBe(NOW - 6 * DAY)
    stop()
  })

  test('a draft changed after it was put back is written with the new time', async () => {
    const old = draftRecord({ updatedAt: NOW - 6 * DAY })
    const { restoreNow, memory, stop } = setup({ disk: entries(old) })
    await restoreNow()
    setDraft(C1, '上次没发的，又加了一句')
    await vi.advanceTimersByTimeAsync(500)
    const stored = memory.data.get(keyOf(old)) as DraftRecord
    expect(stored.text).toBe('上次没发的，又加了一句')
    expect(stored.updatedAt).toBe(NOW)
    stop()
  })

  test('if the account changed while the disk was being read, nothing is put back', async () => {
    const { persistence, restoreNow, current, memory, stop } = setup({
      disk: entries(draftRecord()),
    })
    const restoring = restoreNow()
    current.scope = scopeOf({ userId: 'user-b', generation: 2 })
    await restoring
    expect(useDrafts.getState().byConversation).toEqual({})
    expect(persistence.armed).toBe(false)
    expect(memory.data.size).toBe(1)
    stop()
  })
})

test('restoring a queue stops if the account ended while obsolete disk records were being removed', async () => {
  const made = setup({ disk: entries(draftRecord({ membershipId: uuid(99) }), queuedRecord()) })
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const started = new Promise<void>((done) => {
    reached = done
  })
  made.memory.backend.delete = async () => {
    reached()
    await gate
  }
  const restoring = made.restoreNow()
  await started
  made.current.scope = scopeOf({ userId: 'user-b', generation: 2 })
  made.persistence.disarm()
  release()
  await restoring
  expect(made.restored).toEqual([])
  made.stop()
})

describe('keeping the stores on disk', () => {
  async function armed(options: Parameters<typeof setup>[0] = {}) {
    const made = setup(options)
    await made.restoreNow()
    return made
  }

  test('a draft is written after a pause, with the membership it belongs to', async () => {
    const { memory, stop } = await armed()
    setDraft(C1, '写到一半')
    setDraft(C1, '写到一半的话')
    await vi.advanceTimersByTimeAsync(399)
    expect(memory.log).toEqual([])
    await vi.advanceTimersByTimeAsync(2)
    expect(memory.log).toEqual([`set ${draftKey('user-a', C1)}`])
    expect(memory.data.get(draftKey('user-a', C1))).toEqual({
      kind: 'draft',
      userId: 'user-a',
      authEpoch: 3,
      restoreEpoch: 'r1',
      updatedAt: NOW,
      conversationId: C1,
      membershipId: M1,
      text: '写到一半的话',
    })
    stop()
  })

  test('only a change is written; a draft that is emptied is removed; a draft that is not a draft is not kept', async () => {
    const { memory, stop } = await armed()
    setDraft(C1, 'hello')
    await vi.advanceTimersByTimeAsync(500)
    memory.log.length = 0
    setDraft(C2, '   ')
    await vi.advanceTimersByTimeAsync(500)
    expect(memory.log).toEqual([])
    setDraft(C1, '')
    await vi.advanceTimersByTimeAsync(500)
    expect(memory.log).toEqual([`delete ${draftKey('user-a', C1)}`])
    stop()
  })

  test('a conversation the person is not a member of keeps no draft', async () => {
    const { memory, stop } = await armed({ memberships: {} })
    setDraft(C1, 'hello')
    await vi.advanceTimersByTimeAsync(500)
    expect(memory.data.size).toBe(0)
    stop()
  })

  test('while a message is being edited, the field is the edit and what was kept stays as it was', async () => {
    const { memory, stop } = await armed({ disk: entries(draftRecord()) })
    expect(useDrafts.getState().byConversation[C1]).toBe('上次没发的')
    startEdit(C1, M1, makeMessage(1, { conversationId: C1, body: '已经发出的' }), '上次没发的')
    setDraft(C1, '已经发出的，改一下')
    await vi.advanceTimersByTimeAsync(500)
    expect((memory.data.get(draftKey('user-a', C1)) as DraftRecord).text).toBe('上次没发的')
    stop()
  })

  test('a message that is sending, queued or waiting is kept as waiting; a failed one as failed; one with a file not at all', async () => {
    const { memory, stop } = await armed()
    putPending(
      pending({ clientId: uuid(920), state: 'sending' }),
      pending({ clientId: uuid(921), state: 'queued' }),
      pending({ clientId: uuid(922), state: 'offline' }),
      pending({ clientId: uuid(923), state: 'failed', error: 'FORBIDDEN' }),
      pending({
        clientId: uuid(924),
        attachments: [
          { id: uuid(5) } as unknown as NonNullable<PendingMessage['attachments']>[number],
        ],
      }),
      pending({
        clientId: uuid(925),
        quote: { id: uuid(6), seq: 1, senderId: uuid(7), excerpt: '别人的话', state: 'ok' },
      }),
    )
    await vi.advanceTimersByTimeAsync(500)
    const stored = (n: number) =>
      memory.data.get(queuedKey('user-a', uuid(n))) as QueuedRecord | undefined
    expect(stored(920)).toMatchObject({ state: 'offline', error: null })
    expect(stored(921)).toMatchObject({ state: 'offline' })
    expect(stored(922)).toMatchObject({ state: 'offline' })
    expect(stored(923)).toMatchObject({ state: 'failed', error: 'FORBIDDEN' })
    expect(stored(924)).toBeUndefined()
    // Somebody else's words are never written, not even the excerpt of a quote.
    expect(JSON.stringify([...memory.data.values()])).not.toContain('别人的话')
    stop()
  })

  test('a message that was accepted is removed from the disk', async () => {
    const { memory, stop } = await armed()
    putPending(pending({ state: 'offline' }))
    await vi.advanceTimersByTimeAsync(500)
    expect(memory.data.size).toBe(1)
    useOutbox.setState({ byConversation: {} })
    await vi.advanceTimersByTimeAsync(500)
    expect(memory.data.size).toBe(0)
    stop()
  })

  test('flushing writes at once, as the page is hidden', async () => {
    const { persistence, memory, stop } = await armed()
    setDraft(C1, 'bye')
    await persistence.flush()
    expect(memory.data.has(draftKey('user-a', C1))).toBe(true)
    stop()
  })

  test('the list becoming known gives drafts typed before that their membership', async () => {
    const { restoreNow, memory, memberships, stop } = setup({ memberships: {} })
    await restoreNow()
    setDraft(C1, '列表还没出来时打的')
    await vi.advanceTimersByTimeAsync(500)
    expect(memory.data.size).toBe(0)
    memberships[C1] = M1
    useSyncUi.setState({ ready: true })
    await vi.advanceTimersByTimeAsync(500)
    expect((memory.data.get(draftKey('user-a', C1)) as DraftRecord).membershipId).toBe(M1)
    stop()
  })
})

describe('when the account ends', () => {
  test('writing stops at once, even for a change that was waiting to be written', async () => {
    const { persistence, restoreNow, memory, stop } = setup()
    await restoreNow()
    setDraft(C1, 'secret')
    persistence.disarm()
    await vi.advanceTimersByTimeAsync(5000)
    expect(memory.log).toEqual([])
    setDraft(C1, 'more secret')
    await vi.advanceTimersByTimeAsync(5000)
    expect(memory.log).toEqual([])
    stop()
  })

  test('another account arriving disarms it; the same person under a new login generation is written under the new stamp', async () => {
    const { persistence, restoreNow, memory, current, stop } = setup()
    await restoreNow()
    setDraft(C1, 'mine')
    await vi.advanceTimersByTimeAsync(500)
    expect((memory.data.get(draftKey('user-a', C1)) as DraftRecord).authEpoch).toBe(3)

    const renewed = scopeOf({ authEpoch: 4, generation: 2 })
    current.scope = renewed
    useSyncUi.setState({ scope: renewed })
    await vi.advanceTimersByTimeAsync(500)
    expect((memory.data.get(draftKey('user-a', C1)) as DraftRecord).authEpoch).toBe(4)
    expect(persistence.armed).toBe(true)

    const other = scopeOf({ userId: 'user-b', generation: 3 })
    current.scope = other
    useSyncUi.setState({ scope: other })
    expect(persistence.armed).toBe(false)
    stop()
  })

  test('the session ending (no scope) disarms it', async () => {
    const { persistence, restoreNow, current, stop } = setup()
    await restoreNow()
    useSyncUi.setState({ scope: scopeOf() })
    current.scope = null
    useSyncUi.setState({ scope: null })
    expect(persistence.armed).toBe(false)
    stop()
  })
})
