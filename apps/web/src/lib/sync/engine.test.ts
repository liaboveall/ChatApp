import type { Conversation, Me, WsServerMessage } from '@chatapp/contracts'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../api.ts'
import { queryKeys } from '../queries.ts'
import { type ForgetReason, SyncEngine } from './engine.ts'
import { FakeServer } from './fake-server.ts'
import { makeAccount, makeConversation, makeMe, makeMessage, makeUser, uuid } from './fixtures.ts'
import { syncKeys } from './keys.ts'
import { syncUi, useSyncUi } from './state.ts'
import type { ConversationIndex, SyncScope, TimelineWindow } from './types.ts'
import { WINDOW_MAX } from './window.ts'

const T0 = Date.parse('2026-10-04T08:00:00.000Z')
const CONV = uuid(500)
const M1 = uuid(700)
const M2 = uuid(701)

const hint = (changeSeq: number, conversationId = CONV): WsServerMessage => ({
  v: 1,
  type: 'message.changed',
  topic: `conv:${conversationId}`,
  data: { conversationId, messageId: uuid(1), changeSeq },
})

const tick = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

type Setup = ReturnType<typeof setup>

function setup(options: { conversation?: Conversation; seed?: number; me?: Me } = {}) {
  const qc = new QueryClient()
  const conversation =
    options.conversation ??
    makeConversation(500, { me: makeMe({ membershipId: M1, lastReadSeq: options.seed ?? 0 }) })
  const server = new FakeServer(conversation)
  for (let i = 1; i <= (options.seed ?? 0); i += 1) server.add(`m${i}`)
  const forgotten: Array<[string, ForgetReason]> = []
  const stopped = vi.fn()
  const state = { online: true }
  const engine = new SyncEngine({
    queryClient: qc,
    transport: server,
    isVisible: () => true,
    isOnline: () => state.online,
    random: () => 0.5,
    onForgotten: (id, reason) => forgotten.push([id, reason]),
    onStop: stopped,
  })
  const me = options.me ?? makeAccount()
  const scope = () => {
    const current = engine.scope
    if (current === null) throw new Error('engine is not started')
    return current
  }
  return {
    engine,
    server,
    qc,
    me,
    scope,
    forgotten,
    stopped,
    state,
    index: () => qc.getQueryData<ConversationIndex>(syncKeys.conversations(scope())),
    window: (membershipId = M1) =>
      qc.getQueryData<TimelineWindow>(syncKeys.timeline(scope(), CONV, membershipId)),
    seqs: () => engine.windowOf(CONV)?.messages.map((m) => m.seq) ?? [],
  }
}

/** Starts the engine and opens the conversation, the way the conversation screen does. */
async function open(t: Setup): Promise<void> {
  await t.engine.start(t.me)
  await t.engine.openConversation(CONV)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  syncUi.reset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('starting', () => {
  test('loads the conversation list, becomes ready and starts its own log at the snapshot position', async () => {
    const t = setup({ seed: 3 })
    await t.engine.start(t.me)
    expect(useSyncUi.getState().ready).toBe(true)
    expect(t.index()?.byId[CONV]?.lastSeq).toBe(3)
    expect(t.engine.userProgress()).toEqual({ observed: 1, synced: 1 })
    expect(t.server.calls).toEqual(['listConversations'])
    t.engine.stop()
  })

  test('starting again for the same identity reads nothing again', async () => {
    const t = setup()
    await t.engine.start(t.me)
    await t.engine.start(t.me)
    expect(t.server.count('listConversations')).toBe(1)
    t.engine.stop()
  })

  test('a failed first load is retried with a growing pause until it works', async () => {
    const t = setup()
    t.server.failNext('listConversations', new ApiError(0, 'NETWORK'), 2)
    await t.engine.start(t.me)
    expect(useSyncUi.getState()).toMatchObject({ ready: false, loadError: true })
    await tick(1000)
    expect(useSyncUi.getState().ready).toBe(false)
    await tick(2000)
    expect(useSyncUi.getState()).toMatchObject({ ready: true, loadError: false })
    expect(t.server.count('listConversations')).toBe(3)
    t.engine.stop()
  })

  test('hints that arrive while the list is still loading are acted on once it is there', async () => {
    const t = setup({ seed: 2 })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    t.server.hook = (name) => (name === 'listConversations' ? gate : undefined)
    const starting = t.engine.start(t.me)
    t.engine.onEvent(hint(2))
    release()
    await starting
    await tick(100)
    expect(t.server.count('getConversation')).toBe(1)
    t.engine.stop()
  })

  test('stopping drops the scope, tells the stores outside and clears the screen state', async () => {
    const t = setup({ seed: 2 })
    await open(t)
    const scope = t.engine.scope
    t.engine.stop()
    expect(t.engine.scope).toBeNull()
    expect(t.stopped).toHaveBeenCalledTimes(1)
    expect(useSyncUi.getState()).toMatchObject({ scope: null, ready: false, timelines: {} })
    expect(scope).not.toBeNull()
    const calls = t.server.calls.length
    await tick(120_000)
    expect(t.server.calls).toHaveLength(calls)
  })
})

describe('the dictionary of people', () => {
  test('knows a person once a screen has brought them in, and nobody before, or after the engine stops', async () => {
    const t = setup({ seed: 1 })
    expect(t.engine.knowsUser(uuid(900))).toBe(false)
    await open(t)
    expect(t.engine.knowsUser(uuid(900))).toBe(false)
    t.engine.ingestUsers([makeUser(900)])
    expect(t.engine.knowsUser(uuid(900))).toBe(true)
    expect(t.engine.knowsUser(uuid(901))).toBe(false)
    t.engine.stop()
    expect(t.engine.knowsUser(uuid(900))).toBe(false)
  })
})

describe('opening a conversation', () => {
  test('reads the newest page and starts catching up from the position known before it', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    expect(t.seqs()).toEqual([1, 2, 3])
    expect(t.engine.progress(CONV)).toEqual({ observed: 0, synced: 3 })
    expect(useSyncUi.getState().timelines[CONV]).toBe('ready')
    t.engine.stop()
  })

  test('a change that lands between the position and the page is in the page and is not applied twice', async () => {
    const t = setup({ seed: 3 })
    await t.engine.start(t.me)
    t.server.hook = (name) => {
      if (name === 'listMessages') t.server.add('arrived during the read')
    }
    await t.engine.openConversation(CONV)
    t.server.hook = undefined
    expect(t.seqs()).toEqual([1, 2, 3, 4])
    expect(t.engine.progress(CONV)?.synced).toBe(3)
    t.engine.onEvent(hint(4))
    await tick(10)
    expect(t.seqs()).toEqual([1, 2, 3, 4])
    expect(t.engine.progress(CONV)?.synced).toBe(4)
    t.engine.stop()
  })

  test('puts the separator after what I had read when I opened it', async () => {
    const t = setup({
      seed: 6,
      conversation: makeConversation(500, { me: makeMe({ membershipId: M1, lastReadSeq: 4 }) }),
    })
    await open(t)
    expect(useSyncUi.getState().anchors[CONV]).toBe(4)
    t.engine.stop()
  })

  test('with many unread messages the page around the first unread one is read, and the window is detached', async () => {
    const t = setup({
      seed: 300,
      conversation: makeConversation(500, { me: makeMe({ membershipId: M1, lastReadSeq: 100 }) }),
    })
    await open(t)
    const range = t.seqs()
    expect(range).toContain(101)
    expect(range.at(-1)).toBeLessThan(300)
    expect(t.engine.windowOf(CONV)?.hasMoreAfter).toBe(true)
    expect(t.server.count('listMessages')).toBe(2)
    t.engine.stop()
  })

  test('a conversation I am not in has no timeline', async () => {
    const t = setup({ conversation: makeConversation(500, { me: null, kind: 'channel' }) })
    await t.engine.start(t.me)
    await t.engine.openConversation(CONV)
    expect(t.engine.windowOf(CONV)).toBeUndefined()
    expect(useSyncUi.getState().timelines[CONV]).toBeUndefined()
    t.engine.stop()
  })

  test('a failed read leaves an error state the screen can retry from', async () => {
    const t = setup({ seed: 2 })
    await t.engine.start(t.me)
    t.server.failNext('listMessages', new ApiError(500, 'INTERNAL'))
    await t.engine.openConversation(CONV)
    expect(useSyncUi.getState().timelines[CONV]).toBe('error')
    await t.engine.openConversation(CONV)
    expect(useSyncUi.getState().timelines[CONV]).toBe('ready')
    t.engine.stop()
  })
})

describe('hints and catch-up', () => {
  test('a hint is replayed within a moment: the message appears once, the list line and counters follow', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.server.add('hello there')
    t.engine.onEvent(hint(4))
    expect(t.engine.progress(CONV)).toEqual({ observed: 4, synced: 3 })
    await tick(10)
    expect(t.seqs()).toEqual([1, 2, 3, 4])
    expect(t.engine.progress(CONV)?.synced).toBe(4)
    const row = t.index()?.byId[CONV]
    expect(row).toMatchObject({ lastSeq: 4, lastChangeSeq: 4 })
    expect(row?.lastMessagePreview?.text).toBe('hello there')
    t.engine.stop()
  })

  test('an edit and a recall replace the message in place, and a quote of it follows', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const quoting = t.server.add('a reply', {
      replyTo: {
        id: t.server.messages[0]?.id ?? '',
        seq: 1,
        senderId: uuid(2),
        excerpt: 'm1',
        state: 'ok',
      },
    })
    t.engine.onEvent(hint(quoting.changeSeq))
    await tick(10)
    const edited = t.server.edit(1, 'changed text')
    t.engine.onEvent(hint(edited.changeSeq))
    await tick(60)
    const window = t.engine.windowOf(CONV)
    expect(window?.messages[0]?.body).toBe('changed text')
    expect(window?.messages.at(-1)?.replyTo).toMatchObject({ state: 'ok', excerpt: 'changed text' })
    const recalled = t.server.recall(1)
    t.engine.onEvent(hint(recalled.changeSeq))
    await tick(60)
    expect(t.engine.windowOf(CONV)?.messages[0]?.recalledAt).not.toBeNull()
    expect(t.engine.windowOf(CONV)?.messages.at(-1)?.replyTo).toMatchObject({
      state: 'recalled',
      excerpt: null,
    })
    t.engine.stop()
  })

  test('a message that left my view is taken out, and an old copy of it cannot return', async () => {
    const t = setup({ seed: 4 })
    await open(t)
    const gone = t.server.messages[1]
    t.server.vanish(2)
    t.engine.onEvent(hint(t.server.head))
    await tick(10)
    expect(t.seqs()).toEqual([1, 3, 4])
    expect(t.engine.windowOf(CONV)?.gone[gone?.id ?? '']).toBe(t.server.head)
    t.engine.stop()
  })

  test('hearing of a change never counts as applying it: observed moves on a hint, synced only on replay', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.engine.onEvent(hint(50))
    expect(t.engine.progress(CONV)).toEqual({ observed: 50, synced: 3 })
    await tick(10)
    // The log has nothing beyond 3: the claim of 50 is not turned into a position.
    expect(t.engine.progress(CONV)?.synced).toBe(3)
    t.engine.stop()
  })

  test('a claim beyond the log is dropped once a round that started after it has found nothing, not chased for ever', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.engine.onEvent(hint(50))
    await tick(10)
    const calls = t.server.count('conversationChanges')
    await tick(30_000)
    expect(t.server.count('conversationChanges')).toBe(calls)
    expect(t.engine.progress(CONV)).toEqual({ observed: 3, synced: 3 })
    t.engine.stop()
  })

  test('changes that happen while a multi-page replay runs belong to the next round (fixed upper bound)', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    for (let i = 0; i < 150; i += 1) t.server.add(`bulk ${i}`)
    let injected = false
    t.server.hook = (name, args) => {
      const query = args[1] as { cursor?: string } | undefined
      if (name === 'conversationChanges' && query?.cursor !== undefined && !injected) {
        injected = true
        t.server.add('arrived mid replay')
      }
    }
    t.engine.onEvent(hint(153))
    await tick(10)
    expect(t.engine.progress(CONV)?.synced).toBe(153)
    expect(t.seqs().at(-1)).toBe(153)
    t.engine.onEvent(hint(154))
    await tick(60)
    expect(t.seqs().at(-1)).toBe(154)
    expect(t.engine.progress(CONV)?.synced).toBe(154)
    expect(new Set(t.seqs()).size).toBe(t.seqs().length)
    t.engine.stop()
  })

  test('a lost hint is repaired by the reconciliation: converged within 35 seconds, nothing in between', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.server.add('nobody told the client')
    await tick(2900)
    expect(t.seqs()).toEqual([1, 2, 3])
    await tick(30_000 - 2900 + 100)
    expect(t.server.count('syncHeads')).toBe(1)
    expect(t.seqs()).toEqual([1, 2, 3, 4])
    t.engine.stop()
  })

  test('the same change replayed twice leaves one row', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.server.add('once')
    t.engine.onEvent(hint(4))
    await tick(10)
    t.engine.onEvent(hint(4))
    t.server.add('twice')
    t.engine.onEvent(hint(5))
    await tick(3000)
    expect(t.seqs()).toEqual([1, 2, 3, 4, 5])
    t.engine.stop()
  })

  test('while the browser is offline nothing is requested, and coming back catches up', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.state.online = false
    t.server.add('while away')
    t.engine.onEvent(hint(4))
    await tick(5000)
    expect(t.server.count('conversationChanges')).toBe(0)
    t.state.online = true
    t.engine.onForeground()
    await tick(10)
    expect(t.seqs()).toEqual([1, 2, 3, 4])
    t.engine.stop()
  })

  test('a log that cannot be replayed starts over from the snapshot it carries', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    for (let i = 0; i < 5; i += 1) t.server.add(`later ${i}`)
    t.server.resetNext = true
    t.engine.onEvent(hint(8))
    await tick(10)
    expect(t.seqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(t.engine.progress(CONV)).toEqual({ observed: 8, synced: 8 })
    t.engine.stop()
  })

  test('failed rounds are retried with a growing pause and shown as not synced until one succeeds', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.server.add('x')
    t.server.failNext('conversationChanges', new ApiError(0, 'NETWORK'), 2)
    t.engine.onEvent(hint(4))
    await tick(10)
    expect(useSyncUi.getState().failures[CONV]).toBe(1)
    expect(t.seqs()).toEqual([1, 2, 3])
    await tick(1000)
    expect(useSyncUi.getState().failures[CONV]).toBe(2)
    await tick(2000)
    expect(useSyncUi.getState().failures[CONV]).toBeUndefined()
    expect(t.seqs()).toEqual([1, 2, 3, 4])
    t.engine.stop()
  })
})

describe('write answers and late answers (AT-31)', () => {
  test('an answer to a write is merged by version: the new name stays when an older read arrives after it', async () => {
    const t = setup({ seed: 2 })
    await t.engine.start(t.me)
    const renamed = { ...t.server.conversation, name: 'Renamed', metadataVersion: 5 }
    const stale = { ...t.server.conversation, name: 'Old name', metadataVersion: 3 }
    t.engine.ingestConversation(renamed)
    t.engine.ingestConversation(stale)
    expect(t.index()?.byId[CONV]?.name).toBe('Renamed')
    t.engine.stop()
  })

  test('the answer to sending a message is placed in the window by its seq without waiting for a hint', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const sent = t.server.add('sent by me', { senderId: t.me.id })
    t.engine.ingestMessage({ message: sent, users: { [t.me.id]: makeUser(1) } })
    expect(t.seqs()).toEqual([1, 2, 3, 4])
    await tick(10)
    expect(t.seqs()).toEqual([1, 2, 3, 4])
    t.engine.stop()
  })

  test('an answer to a request made before the scope changed is dropped', async () => {
    const t = setup({ seed: 3 })
    await t.engine.start(t.me)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    t.server.hook = (name) => (name === 'listMessages' ? gate : undefined)
    const opening = t.engine.openConversation(CONV)
    await tick(1)
    await t.engine.switchScope(makeAccount({ authEpoch: 2 }))
    t.server.hook = undefined
    release()
    await opening
    expect(
      t.qc.getQueryData(syncKeys.timeline({ ...t.scope(), authEpoch: 1 }, CONV, M1)),
    ).toBeUndefined()
    expect(t.engine.windowOf(CONV)).toBeUndefined()
    t.engine.stop()
  })
})

describe('losing access', () => {
  test('a 404 on the change log removes the conversation everywhere and says why', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.server.failNext('conversationChanges', new ApiError(404, 'NOT_FOUND'))
    t.server.add('x')
    t.engine.onEvent(hint(4))
    await tick(10)
    expect(t.forgotten).toEqual([[CONV, 'no-access']])
    expect(t.index()?.byId[CONV]).toBeUndefined()
    expect(t.qc.getQueryData(syncKeys.timeline(t.scope(), CONV, M1))).toBeUndefined()
    expect(useSyncUi.getState().timelines[CONV]).toBeUndefined()
    t.engine.stop()
  })

  test('a 403 for "not a member" does the same; a 403 for anything else concerns one action only', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.server.add('x')
    t.server.failNext(
      'conversationChanges',
      new ApiError(403, 'FORBIDDEN', { details: { reason: 'requires_admin' } }),
    )
    t.engine.onEvent(hint(4))
    await tick(10)
    expect(t.forgotten).toEqual([])
    expect(t.index()?.byId[CONV]).toBeDefined()
    await tick(2000)
    t.server.add('y')
    t.server.failNext(
      'conversationChanges',
      new ApiError(403, 'FORBIDDEN', { details: { reason: 'not_member' } }),
    )
    t.engine.onEvent(hint(t.server.head))
    await tick(10)
    expect(t.forgotten).toEqual([[CONV, 'no-access']])
    t.engine.stop()
  })

  test('my own log: a newer removal ends the relation, an older one (before a re-join) does not', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const version = t.index()?.byId[CONV]?.me?.version ?? 0
    t.server.personal = [
      {
        type: 'conversation.removed',
        conversationId: CONV,
        membershipId: uuid(799),
        state: 'removed',
        viewerVersion: version + 5,
      },
    ]
    t.engine.onEvent({ v: 1, type: 'user.changed', topic: 'user:x', data: { userChangeSeq: 2 } })
    await tick(10)
    expect(t.forgotten).toEqual([])
    t.server.personal = [
      {
        type: 'conversation.removed',
        conversationId: CONV,
        membershipId: M1,
        state: 'removed',
        viewerVersion: version,
      },
    ]
    t.engine.onEvent({ v: 1, type: 'user.changed', topic: 'user:x', data: { userChangeSeq: 3 } })
    await tick(600)
    expect(t.forgotten).toEqual([])
    t.server.personal = [
      {
        type: 'conversation.removed',
        conversationId: CONV,
        membershipId: M1,
        state: 'removed',
        viewerVersion: version + 1,
      },
    ]
    t.server.userSeq = 4
    t.engine.onEvent({ v: 1, type: 'user.changed', topic: 'user:x', data: { userChangeSeq: 4 } })
    await tick(600)
    expect(t.forgotten).toEqual([[CONV, 'removed']])
    expect(t.index()?.removed[CONV]).toEqual({ viewerVersion: version + 1, membershipId: M1 })
    t.engine.stop()
  })

  test('a removal hint alone deletes nothing: it only makes the engine read its own log', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.engine.onEvent({
      v: 1,
      type: 'conversation.removed',
      topic: 'user:x',
      data: { conversationId: CONV, userChangeSeq: 2 },
    })
    expect(t.forgotten).toEqual([])
    expect(t.index()?.byId[CONV]).toBeDefined()
    t.engine.stop()
  })

  test('a snapshot of my own log without a live conversation removes it; an archived one is not judged by absence', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.server.personalReset = { me: t.me, conversations: [], baselineUserSeq: 9 }
    t.engine.onEvent({ v: 1, type: 'user.changed', topic: 'user:x', data: { userChangeSeq: 9 } })
    await tick(10)
    expect(t.forgotten).toEqual([[CONV, 'snapshot']])
    expect(t.engine.userProgress()).toEqual({ observed: 9, synced: 9 })

    const archived = setup({
      seed: 3,
      conversation: makeConversation(500, {
        me: makeMe({ membershipId: M1 }),
        archivedAt: '2026-10-04T08:00:00.000Z',
      }),
    })
    await open(archived)
    archived.server.personalReset = { me: archived.me, conversations: [], baselineUserSeq: 9 }
    archived.engine.onEvent({
      v: 1,
      type: 'user.changed',
      topic: 'user:x',
      data: { userChangeSeq: 9 },
    })
    await tick(10)
    expect(archived.forgotten).toEqual([])
    archived.engine.stop()
    t.engine.stop()
  })

  test('a re-join (a different membership) removes everything cached under the old one in the same step', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    expect(t.window(M1)).toBeDefined()
    const rejoined = makeConversation(500, {
      me: makeMe({ membershipId: M2, version: 9, visibleFromSeq: 3 }),
      lastSeq: 3,
    })
    t.qc.setQueryData(syncKeys.members(t.scope(), CONV), {
      cached: 'members of the old membership',
    })
    t.engine.ingestConversation(rejoined)
    expect(t.window(M1)).toBeUndefined()
    expect(t.qc.getQueryData(syncKeys.members(t.scope(), CONV))).toBeUndefined()
    expect(t.index()?.byId[CONV]?.me?.membershipId).toBe(M2)
    expect(useSyncUi.getState().timelines[CONV]).toBeUndefined()
    t.engine.stop()
  })
})

describe('the request budget', () => {
  test('a burst of hints does not become a burst of requests', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    for (let second = 0; second < 5; second += 1) {
      for (let i = 0; i < 20; i += 1) {
        t.server.add(`m ${second}.${i}`)
        t.engine.onEvent(hint(t.server.head))
        await tick(50)
      }
    }
    // 100 messages arrived over 5 seconds; rounds are batched, not one request per hint.
    expect(t.server.count('conversationChanges')).toBeLessThan(60)
    await tick(3000)
    expect(t.seqs().at(-1)).toBe(103)
    t.engine.stop()
  })

  test('a 429 pauses all background requests until the time the server named', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.server.add('x')
    t.server.failNext(
      'conversationChanges',
      new ApiError(429, 'RATE_LIMITED', { retryAfterSeconds: 10 }),
    )
    t.engine.onEvent(hint(4))
    await tick(10)
    const calls = t.server.calls.length
    t.server.add('y')
    t.engine.onEvent(hint(5))
    await tick(9000)
    expect(t.server.calls).toHaveLength(calls)
    await tick(2500)
    expect(t.seqs()).toEqual([1, 2, 3, 4, 5])
    t.engine.stop()
  })
})

describe('reading position', () => {
  test('the unread count drops at once; the request is one at a time and carries the newest wanted position', async () => {
    const t = setup({
      seed: 10,
      conversation: makeConversation(500, { me: makeMe({ membershipId: M1, lastReadSeq: 0 }) }),
    })
    await open(t)
    t.engine.markRead(CONV, 4)
    expect(useSyncUi.getState().pendingRead[CONV]).toBe(4)
    await tick(10)
    expect(t.server.count('markRead')).toBe(1)
    t.engine.markRead(CONV, 7)
    t.engine.markRead(CONV, 9)
    await tick(500)
    expect(t.server.count('markRead')).toBe(1)
    await tick(600)
    expect(t.server.calls.filter((c) => c.startsWith('markRead'))).toEqual([
      'markRead 4',
      'markRead 9',
    ])
    expect(t.index()?.byId[CONV]?.me?.lastReadSeq).toBe(9)
    expect(useSyncUi.getState().pendingRead[CONV]).toBeUndefined()
    t.engine.stop()
  })

  test('a position that is not ahead of what the server has is not sent', async () => {
    const t = setup({
      seed: 10,
      conversation: makeConversation(500, { me: makeMe({ membershipId: M1, lastReadSeq: 8 }) }),
    })
    await open(t)
    t.engine.markRead(CONV, 8)
    t.engine.markRead(CONV, 3)
    await tick(2000)
    expect(t.server.count('markRead')).toBe(0)
    t.engine.stop()
  })

  test('my own sent message counts as read locally without a request, until my log brings the position', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    t.engine.noteSent(CONV, 4)
    expect(useSyncUi.getState().pendingRead[CONV]).toBe(4)
    expect(t.server.count('markRead')).toBe(0)
    const conversation = t.server.conversation
    t.engine.ingestConversation({
      ...conversation,
      viewerVersion: 5,
      me: { ...(conversation.me ?? makeMe()), version: 5, lastReadSeq: 4 },
    })
    expect(useSyncUi.getState().pendingRead[CONV]).toBeUndefined()
    t.engine.stop()
  })
})

describe('moving through the window', () => {
  test('older pages join at the top until the beginning, and the window is cut from the far end beyond its size', async () => {
    const total = WINDOW_MAX + 200
    const t = setup({ seed: total })
    await open(t)
    expect(t.seqs()).toHaveLength(50)
    while (await t.engine.loadOlder(CONV)) await tick(0)
    await tick(100)
    const window = t.engine.windowOf(CONV)
    expect(window?.messages).toHaveLength(WINDOW_MAX)
    expect(window?.hasMoreAfter).toBe(true)
    expect(window?.hasMoreBefore).toBe(false)
    expect(window?.messages[0]?.seq).toBe(1)
    t.engine.stop()
  }, 30_000)

  test('jumping to a message already held reads nothing; one outside replaces the window; one that is not there says so', async () => {
    const t = setup({ seed: 400 })
    await open(t)
    const calls = t.server.count('listMessages')
    expect(await t.engine.jumpTo(CONV, 390)).toBe('in-window')
    expect(t.server.count('listMessages')).toBe(calls)
    expect(await t.engine.jumpTo(CONV, 100)).toBe('loaded')
    const window = t.engine.windowOf(CONV)
    expect(window?.messages.some((m) => m.seq === 100)).toBe(true)
    expect(window?.hasMoreAfter).toBe(true)
    expect(await t.engine.jumpTo(CONV, 99_999)).toBe('unavailable')
    t.engine.stop()
  })

  test('going back to the latest reads the newest page again for a detached window, and does nothing otherwise', async () => {
    const t = setup({ seed: 400 })
    await open(t)
    const before = t.server.count('listMessages')
    await t.engine.backToLatest(CONV)
    expect(t.server.count('listMessages')).toBe(before)
    await t.engine.jumpTo(CONV, 100)
    await t.engine.backToLatest(CONV)
    expect(t.engine.windowOf(CONV)?.hasMoreAfter).toBe(false)
    expect(t.seqs().at(-1)).toBe(400)
    t.engine.stop()
  })

  test('a newer page extends a detached window downward', async () => {
    const t = setup({ seed: 400 })
    await open(t)
    await t.engine.jumpTo(CONV, 100)
    const first = t.seqs().at(-1) ?? 0
    expect(await t.engine.loadNewer(CONV)).toBe(true)
    expect(t.seqs().at(-1)).toBeGreaterThan(first)
    t.engine.stop()
  })
})

describe('my own log', () => {
  test('conversation items and my account are merged by version, hidden messages leave the window', async () => {
    const t = setup({ seed: 4 })
    t.qc.setQueryData(queryKeys.me, t.me)
    await open(t)
    const hidden = t.server.messages[1]
    t.server.personal = [
      {
        type: 'conversation',
        conversation: { ...t.server.conversation, name: 'Named later', metadataVersion: 7 },
      },
      { type: 'message.hidden', conversationId: CONV, messageId: hidden?.id ?? '' },
      { type: 'me', me: { ...t.me, meVersion: 4, displayName: 'New Name' } },
    ]
    t.server.userSeq = 2
    t.engine.onEvent({ v: 1, type: 'user.changed', topic: 'user:x', data: { userChangeSeq: 2 } })
    await tick(10)
    expect(t.index()?.byId[CONV]?.name).toBe('Named later')
    expect(t.seqs()).toEqual([1, 3, 4])
    expect(t.qc.getQueryData<Me>(queryKeys.me)?.displayName).toBe('New Name')
    expect(t.engine.userProgress().synced).toBe(2)
    t.engine.stop()
  })

  test('a message hidden while the conversation had no window is left out when the window is built', async () => {
    const t = setup({ seed: 4 })
    await t.engine.start(t.me)
    const hidden = t.server.messages[2]
    t.server.personal = [
      { type: 'message.hidden', conversationId: CONV, messageId: hidden?.id ?? '' },
    ]
    t.server.userSeq = 2
    t.engine.onEvent({ v: 1, type: 'user.changed', topic: 'user:x', data: { userChangeSeq: 2 } })
    await tick(10)
    await t.engine.openConversation(CONV)
    expect(t.seqs()).toEqual([1, 2, 4])
    t.engine.stop()
  })
})

describe('the identity changes under a live session', () => {
  test('a new login generation replaces the scope: old keys go, everything is read again, nothing is signed out', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const oldScope = t.engine.scope
    expect(oldScope).not.toBeNull()
    await t.engine.switchScope(makeAccount({ authEpoch: 2 }))
    expect(t.engine.scope).not.toBe(oldScope)
    expect(t.engine.scope?.authEpoch).toBe(2)
    expect(t.qc.getQueryData(syncKeys.timeline(oldScope as SyncScope, CONV, M1))).toBeUndefined()
    expect(t.qc.getQueryData(syncKeys.conversations(oldScope as SyncScope))).toBeUndefined()
    expect(t.server.count('listConversations')).toBe(2)
    expect(useSyncUi.getState().ready).toBe(true)
    await t.engine.openConversation(CONV)
    expect(t.seqs()).toEqual([1, 2, 3])
    t.engine.stop()
  })
})

describe('the small set of kept windows', () => {
  test('the ninth window pushes out the one opened longest ago, and the open one is never pushed out', async () => {
    const t = setup()
    await t.engine.start(t.me)
    const ids = Array.from({ length: 9 }, (_, i) => uuid(900 + i))
    for (const id of ids) {
      t.engine.ingestConversation(
        makeConversation(900 + ids.indexOf(id), {
          me: makeMe({ membershipId: uuid(2000 + ids.indexOf(id)) }),
        }),
      )
    }
    const transport = vi.spyOn(t.server, 'listMessages').mockImplementation(async () => ({
      messages: [makeMessage(1)],
      users: {},
      hasMoreBefore: false,
      hasMoreAfter: false,
    }))
    for (const id of ids) await t.engine.openConversation(id)
    expect(transport).toHaveBeenCalledTimes(9)
    expect(t.engine.windowOf(ids[0] ?? '')).toBeUndefined()
    for (const id of ids.slice(1)) expect(t.engine.windowOf(id)).toBeDefined()
    expect(useSyncUi.getState().timelines[ids[0] ?? '']).toBeUndefined()
    t.engine.stop()
  })
})
