import type {
  Conversation,
  Me,
  MessageEnvelope,
  MessagesQuery,
  SendMessageRequest,
  WsServerMessage,
} from '@chatapp/contracts'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../api.ts'
import { queryKeys } from '../queries.ts'
import { endCompose, liveTarget, modeOf, startEdit, startReply, useCompose } from './compose.ts'
import { draftOf, setDraft, useDrafts } from './drafts.ts'
import { type ForgetReason, SyncEngine } from './engine.ts'
import { FakeServer } from './fake-server.ts'
import { makeAccount, makeConversation, makeMe, makeMessage, makeUser, uuid } from './fixtures.ts'
import { screenWrites } from './for-screen.ts'
import { syncKeys } from './keys.ts'
import { Outbox, pendingOf, useOutbox } from './outbox.ts'
import { syncUi, useSyncUi } from './state.ts'
import { clearClientStores, clearConversationStores } from './stores.ts'
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
  const resets: string[] = []
  const stopped = vi.fn()
  const state = { online: true }
  const engine = new SyncEngine({
    queryClient: qc,
    transport: server,
    isVisible: () => true,
    isOnline: () => state.online,
    random: () => 0.5,
    onForgotten: (id, reason) => forgotten.push([id, reason]),
    // Wired like the application: the real stores of the sync layer are emptied, and the test can see that it happened.
    onConversationReset: (id) => {
      resets.push(id)
      clearConversationStores(id)
    },
    onStop: () => {
      stopped()
      clearClientStores()
    },
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
    resets,
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
  clearClientStores()
})
afterEach(() => {
  vi.useRealTimers()
  clearClientStores()
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
    t.engine.ingestUsers([makeUser(900)], t.engine.ticket())
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
    t.engine.ingestConversation(renamed, t.engine.ticket())
    t.engine.ingestConversation(stale, t.engine.ticket())
    expect(t.index()?.byId[CONV]?.name).toBe('Renamed')
    t.engine.stop()
  })

  test('the answer to sending a message is placed in the window by its seq without waiting for a hint', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const sent = t.server.add('sent by me', { senderId: t.me.id })
    t.engine.ingestMessage(
      { message: sent, users: { [t.me.id]: makeUser(1) } },
      t.engine.ticket(CONV),
    )
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
    t.engine.ingestConversation(rejoined, t.engine.ticket())
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
    t.engine.ingestConversation(
      {
        ...conversation,
        viewerVersion: 5,
        me: { ...(conversation.me ?? makeMe()), version: 5, lastReadSeq: 4 },
      },
      t.engine.ticket(),
    )
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
        t.engine.ticket(),
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

// ───────── M2b review 2026-10-05 (R2, R3, R4), D-171 ─────────

const defer = <T>() => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * Holds back the answer to the first `listMessages` that `when` accepts until it is released. The page is read as the
 * server has it *when it is asked*, and delivered later: that is what a slow answer is.
 */
function holdPage(t: Setup, when: (query: MessagesQuery) => boolean): { release: () => void } {
  const original = t.server.listMessages.bind(t.server)
  const gate = defer<void>()
  let held = false
  t.server.listMessages = async (id, query) => {
    if (held || !when(query)) return original(id, query)
    held = true
    const page = await original(id, query)
    await gate.promise
    return page
  }
  return { release: () => gate.resolve() }
}

const bodyOf = (t: Setup, seq: number) =>
  t.engine.windowOf(CONV)?.messages.find((message) => message.seq === seq)?.body

describe('a page that replaces the window, and the log applied while it was on its way (R2, AT-12, AT-31)', () => {
  const changes = [
    {
      name: 'an edit',
      change: (t: Setup, seq: number) => t.server.edit(seq, 'edited while the page was on its way'),
      applied: (t: Setup, seq: number) =>
        expect(bodyOf(t, seq)).toBe('edited while the page was on its way'),
    },
    {
      name: 'a recall',
      change: (t: Setup, seq: number) => t.server.recall(seq),
      applied: (t: Setup, seq: number) => {
        expect(bodyOf(t, seq)).toBeNull()
        expect(
          t.engine.windowOf(CONV)?.messages.find((m) => m.seq === seq)?.recalledAt,
        ).not.toBeNull()
      },
    },
    {
      name: 'a deletion by a moderator',
      change: (t: Setup, seq: number) => t.server.deleteAsModerator(seq),
      applied: (t: Setup, seq: number) => {
        expect(bodyOf(t, seq)).toBeNull()
        expect(
          t.engine.windowOf(CONV)?.messages.find((m) => m.seq === seq)?.deletedAt,
        ).not.toBeNull()
      },
    },
  ]
  const places = [
    ['a message the replaced window held too', 55],
    ['a message only the page brings', 20],
  ] as const

  describe.each(changes)('$name', ({ change, applied }) => {
    test.each(places)(
      'a jump page read before it does not bring back %s, and the change is applied to it',
      async (_name, seq) => {
        const t = setup({ seed: 100 })
        await open(t)
        expect(t.seqs()[0]).toBe(51)
        const page = holdPage(t, (query) => query.aroundSeq === 40)
        const jumping = t.engine.jumpTo(CONV, 40)
        await tick(1)
        const changed = change(t, seq)
        t.engine.onEvent(hint(changed.changeSeq))
        await tick(100)
        expect(t.engine.progress(CONV)).toEqual({ observed: 101, synced: 101 })
        const rounds = t.server.count('conversationChanges')

        page.release()
        expect(await jumping).toBe('loaded')
        expect(t.seqs()[0]).toBeLessThan(51)
        await tick(100)
        // The page was read before the change: the log is applied to it again from where it was asked, once, by itself.
        expect(t.server.count('conversationChanges')).toBe(rounds + 1)
        applied(t, seq)
        expect(t.engine.progress(CONV)).toEqual({ observed: 101, synced: 101 })
        await t.engine.reconcile()
        await tick(35_000)
        applied(t, seq)
        t.engine.stop()
      },
    )
  })

  test('a message that the replaced window knew as recalled never shows its text again, not even until the log is replayed', async () => {
    const t = setup({ seed: 100 })
    await open(t)
    const page = holdPage(t, (query) => query.aroundSeq === 40)
    const jumping = t.engine.jumpTo(CONV, 40)
    await tick(1)
    const recall = t.server.recall(55)
    t.engine.onEvent(hint(recall.changeSeq))
    await tick(100)
    expect(bodyOf(t, 55)).toBeNull()
    page.release()
    await jumping
    expect(bodyOf(t, 55)).toBeNull()
    t.engine.stop()
  })

  test('the first page of a conversation, read before a change, is brought up to date from where it was asked', async () => {
    const t = setup({ seed: 100 })
    await t.engine.start(t.me)
    const page = holdPage(
      t,
      (query) => query.beforeSeq === undefined && query.aroundSeq === undefined,
    )
    const opening = t.engine.openConversation(CONV)
    await tick(1)
    const recall = t.server.recall(90)
    t.engine.onEvent(hint(recall.changeSeq))
    await tick(100)
    page.release()
    await opening
    await tick(200)
    expect(bodyOf(t, 90)).toBeNull()
    expect(t.engine.progress(CONV)).toEqual({ observed: 101, synced: 101 })
    t.engine.stop()
  })

  test('an older page read before a change to a message in it is brought up to date from where it was asked', async () => {
    const t = setup({ seed: 100 })
    await open(t)
    const page = holdPage(t, (query) => query.beforeSeq === 51)
    const loading = t.engine.loadOlder(CONV)
    await tick(1)
    const recall = t.server.recall(30)
    t.engine.onEvent(hint(recall.changeSeq))
    await tick(100)
    // Message 30 lies above the window and the window has more above: nothing of it was applied.
    expect(t.engine.progress(CONV)).toEqual({ observed: 101, synced: 101 })
    page.release()
    expect(await loading).toBe(true)
    await tick(100)
    expect(t.seqs()[0]).toBe(1)
    expect(bodyOf(t, 30)).toBeNull()
    expect(t.engine.progress(CONV)).toEqual({ observed: 101, synced: 101 })
    t.engine.stop()
  })

  test('a newer page read before a change to a message in it is brought up to date from where it was asked', async () => {
    const t = setup({ seed: 100 })
    await open(t)
    await t.engine.jumpTo(CONV, 10)
    await tick(100)
    expect(t.engine.windowOf(CONV)?.hasMoreAfter).toBe(true)
    const page = holdPage(t, (query) => query.afterSeq !== undefined)
    const loading = t.engine.loadNewer(CONV)
    await tick(1)
    const edit = t.server.edit(70, 'edited while the page was on its way')
    t.engine.onEvent(hint(edit.changeSeq))
    await tick(100)
    page.release()
    expect(await loading).toBe(true)
    await tick(100)
    expect(bodyOf(t, 70)).toBe('edited while the page was on its way')
    t.engine.stop()
  })

  test('a page that nothing happened to while it was on its way costs no extra round of catch-up', async () => {
    const t = setup({ seed: 100 })
    await open(t)
    const rounds = t.server.count('conversationChanges')
    expect(await t.engine.jumpTo(CONV, 40)).toBe('loaded')
    await tick(5000)
    expect(t.server.count('conversationChanges')).toBe(rounds)
    expect(t.engine.progress(CONV)).toEqual({ observed: 0, synced: 100 })
    t.engine.stop()
  })

  test('of two requests that replace the window the one asked later counts, whichever answer comes first', async () => {
    const t = setup({ seed: 100 })
    await open(t)
    const older = holdPage(t, (query) => query.aroundSeq === 40)
    const jumpingOlder = t.engine.jumpTo(CONV, 40)
    await tick(1)
    const newer = holdPage(t, (query) => query.aroundSeq === 10)
    const jumpingNewer = t.engine.jumpTo(CONV, 10)
    await tick(1)
    older.release()
    expect(await jumpingOlder).toBe('superseded')
    expect(t.seqs()[0]).toBe(51)
    newer.release()
    expect(await jumpingNewer).toBe('loaded')
    expect(t.seqs()[0]).toBe(1)
    t.engine.stop()
  })

  test('the newer request counts also when its answer comes first', async () => {
    const t = setup({ seed: 100 })
    await open(t)
    const older = holdPage(t, (query) => query.aroundSeq === 40)
    const jumpingOlder = t.engine.jumpTo(CONV, 40)
    await tick(1)
    expect(await t.engine.jumpTo(CONV, 10)).toBe('loaded')
    older.release()
    expect(await jumpingOlder).toBe('superseded')
    expect(t.seqs()[0]).toBe(1)
    t.engine.stop()
  })

  test('a jump still on its way when the person goes back to the newest does not take them away again', async () => {
    const t = setup({ seed: 100 })
    await open(t)
    await t.engine.jumpTo(CONV, 10)
    const jump = holdPage(t, (query) => query.aroundSeq === 70)
    const jumping = t.engine.jumpTo(CONV, 70)
    await tick(1)
    await t.engine.backToLatest(CONV)
    expect(t.seqs()[0]).toBe(51)
    expect(t.engine.windowOf(CONV)?.hasMoreAfter).toBe(false)
    jump.release()
    expect(await jumping).toBe('superseded')
    expect(t.seqs()[0]).toBe(51)
    expect(t.engine.windowOf(CONV)?.hasMoreAfter).toBe(false)
    t.engine.stop()
  })

  test('opening a conversation twice at once installs the page asked last, and the one asked first is dropped', async () => {
    const t = setup({ seed: 100 })
    await t.engine.start(t.me)
    const first = holdPage(
      t,
      (query) => query.beforeSeq === undefined && query.aroundSeq === undefined,
    )
    const openingFirst = t.engine.openConversation(CONV)
    await tick(1)
    const recall = t.server.recall(90)
    const openingSecond = t.engine.openConversation(CONV)
    await openingSecond
    expect(bodyOf(t, 90)).toBeNull()
    first.release()
    await openingFirst
    await tick(100)
    expect(bodyOf(t, 90)).toBeNull()
    expect(t.engine.windowOf(CONV)?.messages.find((m) => m.seq === 90)?.changeSeq).toBe(
      recall.changeSeq,
    )
    t.engine.stop()
  })

  test('a page that was on its way when the log said to start over is dropped, and so is its effect on the position', async () => {
    const t = setup({ seed: 100 })
    await open(t)
    const page = holdPage(t, (query) => query.aroundSeq === 40)
    const jumping = t.engine.jumpTo(CONV, 40)
    await tick(1)
    t.server.resetNext = true
    t.server.add('after the snapshot')
    t.engine.onEvent(hint(t.server.head))
    await tick(100)
    expect(t.seqs()[0]).toBe(52)
    page.release()
    expect(await jumping).toBe('unavailable')
    expect(t.seqs()[0]).toBe(52)
    expect(t.engine.progress(CONV)).toEqual({ observed: 101, synced: 101 })
    t.engine.stop()
  })

  test('a page that lands after the window was cut for its size does not mix with the next trim', async () => {
    const t = setup({ seed: 100 })
    await open(t)
    // An older page is on its way when the person jumps: the page would join a window that is gone.
    const older = holdPage(t, (query) => query.beforeSeq === 51)
    const loading = t.engine.loadOlder(CONV)
    await tick(1)
    expect(await t.engine.jumpTo(CONV, 70)).toBe('in-window')
    await t.engine.jumpTo(CONV, 10)
    older.release()
    expect(await loading).toBe(false)
    expect(t.seqs()[0]).toBe(1)
    expect(t.seqs()).toEqual(Array.from({ length: t.seqs().length }, (_, i) => i + 1))
    t.engine.stop()
  })
})

describe('an answer to a reply, and what happened to the message it quotes while it was on its way (R1)', () => {
  const quote = (source: {
    id: string
    seq: number
    senderId: string | null
    body: string | null
  }) => ({
    id: source.id,
    seq: source.seq,
    senderId: source.senderId,
    excerpt: source.body,
    state: 'ok' as const,
  })
  const quoteIn = (t: Setup, id: string) =>
    t.engine.windowOf(CONV)?.messages.find((message) => message.id === id)?.replyTo

  test('the quote of a reply that the server answered before a recall is brought up to date on the way in', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const source = t.server.messages[0]
    expect(source).toBeDefined()
    if (source === undefined) return
    const ticket = t.engine.ticket(CONV)
    const recall = t.server.recall(1)
    t.engine.onEvent(hint(recall.changeSeq))
    await tick(100)
    const reply = makeMessage(4, { id: uuid(9100), changeSeq: 3, replyTo: quote(source) })
    expect(t.engine.ingestMessage({ message: reply, users: {} }, ticket)).toBe(true)
    expect(quoteIn(t, reply.id)).toMatchObject({ state: 'recalled', excerpt: null })
    await tick(200)
    expect(quoteIn(t, reply.id)).toMatchObject({ state: 'recalled', excerpt: null })
    t.engine.stop()
  })

  test('so is the text of a quote of a message that was edited, once the log has been applied again', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const source = t.server.messages[0]
    if (source === undefined) throw new Error('no message')
    const ticket = t.engine.ticket(CONV)
    const edit = t.server.edit(1, 'edited text')
    t.engine.onEvent(hint(edit.changeSeq))
    await tick(100)
    const reply = makeMessage(4, { id: uuid(9100), changeSeq: 3, replyTo: quote(source) })
    t.engine.ingestMessage({ message: reply, users: {} }, ticket)
    await tick(200)
    expect(quoteIn(t, reply.id)).toMatchObject({ state: 'ok', excerpt: 'edited text' })
    t.engine.stop()
  })

  test('also when the quoted message is not in the window', async () => {
    const t = setup({ seed: 100 })
    await open(t)
    const source = t.server.messages[9]
    if (source === undefined) throw new Error('no message')
    expect(t.seqs()[0]).toBe(51)
    const ticket = t.engine.ticket(CONV)
    const recall = t.server.recall(10)
    t.engine.onEvent(hint(recall.changeSeq))
    await tick(100)
    const reply = makeMessage(101, { id: uuid(9100), changeSeq: 100, replyTo: quote(source) })
    t.engine.ingestMessage({ message: reply, users: {} }, ticket)
    await tick(200)
    expect(quoteIn(t, reply.id)).toMatchObject({ state: 'recalled', excerpt: null })
    t.engine.stop()
  })

  test('an answer for a message that was written to be sent stays one catch-up round, not two, when nothing else happened', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const rounds = t.server.count('conversationChanges')
    const ticket = t.engine.ticket(CONV)
    const sent = t.server.add('sent by me', { senderId: t.me.id })
    t.engine.ingestMessage({ message: sent, users: {} }, ticket)
    await tick(500)
    expect(t.server.count('conversationChanges')).toBe(rounds + 1)
    t.engine.stop()
  })
})

describe('answers and failures of requests made for something that is gone (R3, SEC-34)', () => {
  const secret = 'ACCOUNT_A_PRE_JOIN_SECRET'
  const accountB = () =>
    makeAccount({ id: uuid(2), email: 'user2@example.test', username: 'user2' })

  /** The same outbox the application builds in `app/sync.ts`, over the real engine and the real stores. */
  function wiredOutbox(
    t: Setup,
    send: (conversationId: string, request: SendMessageRequest) => Promise<MessageEnvelope>,
  ): Outbox {
    let counter = 0
    return new Outbox({
      send,
      ticket: (conversationId) => t.engine.ticket(conversationId),
      onSent: (envelope, ticket) => t.engine.messageSent(envelope, ticket),
      onAccessError: (conversationId, error, ticket) =>
        t.engine.handleAccessError(conversationId, error, ticket),
      membershipOf: (conversationId) => t.engine.membershipOf(conversationId),
      now: Date.now,
      newId: () => uuid(9000 + ++counter),
    })
  }

  /** B joined after A's message: B's membership starts after it, and the server shows B none of it. */
  async function signInAsB(t: Setup): Promise<void> {
    t.engine.stop()
    t.server.messages = []
    t.server.conversation = {
      ...t.server.conversation,
      me: makeMe({ membershipId: M2, visibleFromSeq: 2, lastReadSeq: 2 }),
    }
    await t.engine.start(accountB())
    await t.engine.openConversation(CONV)
  }

  test('a send answer of the account that signed out never enters the timeline of the next one', async () => {
    const t = setup({ seed: 1 })
    await open(t)
    const answer = defer<MessageEnvelope>()
    const outbox = wiredOutbox(t, () => answer.promise)
    outbox.enqueue({
      conversationId: CONV,
      membershipId: M1,
      body: secret,
      replyToId: null,
      quote: null,
    })
    const accepted = t.server.add(secret, { senderId: t.me.id })
    await signInAsB(t)
    expect(t.seqs()).toEqual([])
    answer.resolve({ message: accepted, users: {} })
    await tick(100)
    expect(t.seqs()).toEqual([])
    expect(JSON.stringify(t.engine.windowOf(CONV))).not.toContain(secret)
    expect(useSyncUi.getState().pendingRead[CONV]).toBeUndefined()
    expect(pendingOf(useOutbox.getState(), CONV)).toEqual([])
    t.engine.stop()
  })

  test('the engine itself refuses a ticket of a scope that is gone, whatever the screen did with its own state', async () => {
    const t = setup({ seed: 1 })
    await open(t)
    const ticket = t.engine.ticket(CONV)
    const accepted = t.server.add(secret, { senderId: t.me.id })
    await signInAsB(t)
    expect(t.engine.ingestMessage({ message: accepted, users: {} }, ticket)).toBe(false)
    expect(t.seqs()).toEqual([])
    t.engine.stop()
  })

  test('a new login generation closes the old tickets too, but not the ones taken under the new one', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const old = t.engine.ticket(CONV)
    await t.engine.switchScope(makeAccount({ authEpoch: 2 }))
    await t.engine.openConversation(CONV)
    const message = t.server.add('written after', { senderId: t.me.id })
    expect(t.engine.ingestMessage({ message, users: {} }, old)).toBe(false)
    expect(t.seqs()).toEqual([1, 2, 3])
    expect(t.engine.ingestMessage({ message, users: {} }, t.engine.ticket(CONV))).toBe(true)
    expect(t.seqs()).toEqual([1, 2, 3, 4])
    t.engine.stop()
  })

  test('an answer to a request made before the person left and joined again does not enter the timeline of the new membership', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const ticket = t.engine.ticket(CONV)
    const old = t.server.messages[2]
    if (old === undefined) throw new Error('no message')
    t.engine.leftConversation(CONV, ticket)
    t.server.messages = t.server.messages.filter((message) => message.seq > 3)
    t.server.conversation = {
      ...t.server.conversation,
      me: makeMe({ membershipId: M2, version: 9, visibleFromSeq: 3 }),
    }
    t.engine.ingestConversation(t.server.conversation, t.engine.ticket())
    await t.engine.openConversation(CONV)
    expect(t.seqs()).toEqual([])
    expect(t.engine.ingestMessage({ message: old, users: {} }, ticket)).toBe(false)
    expect(t.seqs()).toEqual([])
    t.engine.stop()
  })

  test('every way an answer enters is closed to a ticket of a scope that is gone', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const old = t.engine.ticket(CONV)
    const oldAccount = t.engine.ticket()
    await signInAsB(t)
    const index = t.index()
    const window = t.window(M2)
    const users = t.qc.getQueryData(syncKeys.users(t.scope()))
    const strangers = makeUser(900, { displayName: 'A’s contact' })

    t.engine.ingestConversation(
      { ...t.server.conversation, name: 'A’s name for it', metadataVersion: 99 },
      oldAccount,
    )
    t.engine.ingestUsers([strangers], oldAccount)
    t.engine.ingestMe(makeAccount({ meVersion: 50, displayName: 'Account A' }), oldAccount)
    t.engine.applyHidden(CONV, uuid(1), old)
    t.engine.leftConversation(CONV, old)
    expect(t.engine.handleAccessError(CONV, new ApiError(404, 'NOT_FOUND'), old)).toBe(true)
    t.engine.messageSent(
      { message: makeMessage(9, { conversationId: CONV, changeSeq: 99 }), users: {} },
      old,
    )

    expect(t.index()).toBe(index)
    expect(t.window(M2)).toBe(window)
    expect(t.qc.getQueryData(syncKeys.users(t.scope()))).toBe(users)
    expect(t.engine.knowsUser(strangers.id)).toBe(false)
    expect(t.forgotten).toEqual([])
    expect(useSyncUi.getState().pendingRead[CONV]).toBeUndefined()
    t.engine.stop()
  })

  test('a failure of a request made for something that is gone does not take the conversation of the new account away', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const old = t.engine.ticket(CONV)
    await signInAsB(t)
    t.forgotten.length = 0
    expect(t.engine.handleAccessError(CONV, new ApiError(404, 'NOT_FOUND'), old)).toBe(true)
    expect(t.forgotten).toEqual([])
    expect(t.index()?.byId[CONV]).toBeDefined()
    // The same failure of a request made under what is held now is the real thing.
    expect(
      t.engine.handleAccessError(CONV, new ApiError(404, 'NOT_FOUND'), t.engine.ticket(CONV)),
    ).toBe(true)
    expect(t.forgotten).toEqual([[CONV, 'no-access']])
    t.engine.stop()
  })

  test('the late answer to leaving does not make the next account forget the conversation it is in', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const old = t.engine.ticket(CONV)
    await signInAsB(t)
    t.engine.leftConversation(CONV, old)
    expect(t.index()?.byId[CONV]).toBeDefined()
    expect(t.forgotten).toEqual([])
    t.engine.leftConversation(CONV, t.engine.ticket(CONV))
    expect(t.forgotten).toEqual([[CONV, 'left']])
    t.engine.stop()
  })

  test('a failed read made under a membership that has ended says nothing about the one held now', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const wait = defer<void>()
    t.server.hook = (name) => (name === 'getConversation' ? wait.promise : undefined)
    t.server.failNext('getConversation', new ApiError(404, 'NOT_FOUND'))
    const refreshing = t.engine.refreshConversation(CONV)
    await tick(1)
    t.engine.ingestConversation(
      makeConversation(500, { me: makeMe({ membershipId: M2, version: 9, visibleFromSeq: 3 }) }),
      t.engine.ticket(),
    )
    expect(t.index()?.byId[CONV]?.me?.membershipId).toBe(M2)
    t.server.hook = undefined
    wait.resolve()
    await refreshing
    expect(t.forgotten).toEqual([])
    expect(t.index()?.byId[CONV]?.me?.membershipId).toBe(M2)
    t.engine.stop()
  })

  test('so does a failed read-position request', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const wait = defer<void>()
    t.server.hook = (name) => (name === 'markRead' ? wait.promise : undefined)
    t.server.failNext('markRead', new ApiError(404, 'NOT_FOUND'))
    t.engine.markRead(CONV, 3)
    await tick(1)
    t.engine.ingestConversation(
      makeConversation(500, { me: makeMe({ membershipId: M2, version: 9, visibleFromSeq: 3 }) }),
      t.engine.ticket(),
    )
    t.server.hook = undefined
    wait.resolve()
    await tick(50)
    expect(t.forgotten).toEqual([])
    expect(t.index()?.byId[CONV]?.me?.membershipId).toBe(M2)
    t.engine.stop()
  })

  test('another account in the same page empties every store outside the engine; the same account after a password change keeps its drafts', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    setDraft(CONV, 'a draft of A')
    await t.engine.switchScope(makeAccount({ authEpoch: 2 }))
    expect(draftOf(useDrafts.getState(), CONV)).toBe('a draft of A')
    expect(t.stopped).not.toHaveBeenCalled()
    await t.engine.start(accountB())
    expect(t.stopped).toHaveBeenCalledTimes(1)
    expect(draftOf(useDrafts.getState(), CONV)).toBe('')
    t.engine.stop()
  })

  test('a normal send still goes in once, and a retry with the same client id too', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const requests: SendMessageRequest[] = []
    let fail = true
    const outbox = wiredOutbox(t, async (conversationId, request) => {
      requests.push(request)
      if (fail) {
        fail = false
        throw new ApiError(0, 'NETWORK')
      }
      const message = t.server.add(request.body ?? '', { senderId: t.me.id })
      return { message: { ...message, conversationId }, users: {} }
    })
    const pending = outbox.enqueue({
      conversationId: CONV,
      membershipId: M1,
      body: 'hello',
      replyToId: null,
      quote: null,
    })
    await tick(1)
    expect(pendingOf(useOutbox.getState(), CONV)[0]).toMatchObject({
      state: 'failed',
      error: 'NETWORK',
    })
    outbox.retry(pending.clientId, CONV)
    await tick(1)
    expect(requests.map((request) => request.clientId)).toEqual([
      pending.clientId,
      pending.clientId,
    ])
    expect(pendingOf(useOutbox.getState(), CONV)).toEqual([])
    expect(t.seqs()).toEqual([1, 2, 3, 4])
    expect(useSyncUi.getState().pendingRead[CONV]).toBe(4)
    t.engine.stop()
  })
})

describe('what the person wrote under a membership that ended does not outlive it (R4, SEC-34, D-035)', () => {
  const joinedAs = (membershipId: string) =>
    makeConversation(500, {
      me: makeMe({ membershipId, version: 9, visibleFromSeq: 3 }),
      lastSeq: 3,
    })

  function startWriting(t: Setup, mode: 'reply' | 'edit'): void {
    const source = t.server.messages[0]
    if (source === undefined) throw new Error('no message')
    if (mode === 'reply') {
      startReply(CONV, M1, source)
      setDraft(CONV, 'my answer, not sent')
    } else {
      startEdit(CONV, M1, source, 'what I had typed before the edit')
      setDraft(CONV, source.body ?? '')
    }
    // A message that was written and has not gone out yet, quoting an old one.
    const outbox = new Outbox({
      send: () => new Promise<MessageEnvelope>(() => undefined),
      ticket: (id) => t.engine.ticket(id),
      onSent: () => undefined,
      onAccessError: () => false,
      membershipOf: (id) => t.engine.membershipOf(id),
      now: Date.now,
      newId: () => uuid(9001),
    })
    outbox.enqueue({
      conversationId: CONV,
      membershipId: M1,
      body: 'written, not sent',
      replyToId: source.id,
      quote: {
        id: source.id,
        seq: 1,
        senderId: source.senderId,
        excerpt: source.body,
        state: 'ok',
      },
    })
  }

  function expectNothingLeft(membershipId: string): void {
    expect(modeOf(useCompose.getState(), CONV, membershipId)).toBeUndefined()
    expect(useCompose.getState().byConversation[CONV]).toBeUndefined()
    expect(endCompose(CONV, membershipId)).toBeUndefined()
    expect(draftOf(useDrafts.getState(), CONV)).toBe('')
    expect(pendingOf(useOutbox.getState(), CONV)).toEqual([])
  }

  const routes: Array<[string, (t: Setup) => void | Promise<void>, 'gone' | 'new membership']> = [
    ['leaving it', (t) => t.engine.leftConversation(CONV, t.engine.ticket(CONV)), 'gone'],
    [
      'being removed from it (my own log)',
      async (t) => {
        const version = t.index()?.byId[CONV]?.me?.version ?? 0
        t.server.personal = [
          {
            type: 'conversation.removed',
            conversationId: CONV,
            membershipId: M1,
            state: 'removed',
            viewerVersion: version + 1,
          },
        ]
        t.server.userSeq = 3
        t.engine.onEvent({
          v: 1,
          type: 'user.changed',
          topic: 'user:x',
          data: { userChangeSeq: 3 },
        })
        await tick(600)
      },
      'gone',
    ],
    [
      'a different membership read from the server (it changed while I was away)',
      (t) => t.engine.ingestConversation(joinedAs(M2), t.engine.ticket()),
      'new membership',
    ],
    [
      'the change log starting over under a different membership',
      async (t) => {
        t.server.conversation = joinedAs(M2)
        t.server.resetNext = true
        t.server.add('after the snapshot')
        t.engine.onEvent(hint(t.server.head))
        await tick(100)
      },
      'new membership',
    ],
  ]

  describe.each(['reply', 'edit'] as const)('a %s in progress', (mode) => {
    test.each(routes)(
      'is gone after %s, and does not come back when I join again',
      async (_name, route, after) => {
        const t = setup({ seed: 3 })
        await open(t)
        startWriting(t, mode)
        expect(modeOf(useCompose.getState(), CONV, M1)?.type).toBe(mode)
        t.resets.length = 0
        await route(t)
        expect(t.resets).toContain(CONV)
        expectNothingLeft(M1)
        expectNothingLeft(M2)
        if (after === 'gone') {
          t.engine.ingestConversation(joinedAs(M2), t.engine.ticket())
          expect(t.index()?.byId[CONV]?.me?.membershipId).toBe(M2)
          await t.engine.openConversation(CONV)
          expectNothingLeft(M2)
        }
        t.engine.stop()
      },
    )
  })

  test('a membership that changed under a conversation the screen has open is cleaned in the same step as its window', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    startWriting(t, 'reply')
    t.engine.ingestConversation(joinedAs(M2), t.engine.ticket())
    expect(t.window(M1)).toBeUndefined()
    expectNothingLeft(M2)
    t.engine.stop()
  })

  test('a read position claimed under the old membership is not carried into the new one', async () => {
    const t = setup({
      conversation: makeConversation(500, { me: makeMe({ membershipId: M1, lastReadSeq: 1 }) }),
      seed: 5,
    })
    await open(t)
    const wait = defer<void>()
    t.server.hook = (name) => (name === 'markRead' ? wait.promise : undefined)
    t.engine.markRead(CONV, 5)
    await tick(1)
    expect(useSyncUi.getState().pendingRead[CONV]).toBe(5)
    t.engine.ingestConversation(joinedAs(M2), t.engine.ticket())
    expect(useSyncUi.getState().pendingRead[CONV]).toBeUndefined()
    // The request is still out when the pause between two position requests has passed: its end must not send again.
    await tick(2000)
    t.server.hook = undefined
    wait.resolve()
    await tick(2000)
    expect(useSyncUi.getState().pendingRead[CONV]).toBeUndefined()
    // …and no further position of the old membership goes out for the new one.
    expect(t.server.count('markRead')).toBe(1)
    t.engine.stop()
  })

  test('typing signals of the old membership go too', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const { applyTyping, useTyping } = await import('./typing.ts')
    applyTyping(
      { conversationId: CONV, userId: uuid(2), state: 'start', expiresInMs: 5000 },
      uuid(1),
      Date.now(),
    )
    expect(useTyping.getState().byConversation[CONV]).toBeDefined()
    t.engine.ingestConversation(joinedAs(M2), t.engine.ticket())
    expect(useTyping.getState().byConversation[CONV]).toBeUndefined()
    t.engine.stop()
  })

  test('the reply bar stands on the message as the window holds it now, and ends when that message is no target any more', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    startWriting(t, 'reply')
    const mode = modeOf(useCompose.getState(), CONV, M1)
    if (mode === undefined) throw new Error('no reply')
    expect(liveTarget(mode, t.engine.windowOf(CONV))?.body).toBe('m1')
    t.server.edit(1, 'edited text')
    t.engine.onEvent(hint(t.server.head))
    await tick(100)
    expect(liveTarget(mode, t.engine.windowOf(CONV))?.body).toBe('edited text')
    t.server.recall(1)
    t.engine.onEvent(hint(t.server.head))
    await tick(100)
    expect(liveTarget(mode, t.engine.windowOf(CONV))).toBeNull()
    t.engine.stop()
  })
})

describe('what follows from the answer to a request is for the person who asked (D-174)', () => {
  const accountB = () =>
    makeAccount({ id: uuid(2), email: 'user2@example.test', username: 'user2' })
  const joinedAs = (membershipId: string) =>
    makeConversation(500, {
      me: makeMe({ membershipId, version: 9, visibleFromSeq: 3 }),
      lastSeq: 3,
    })

  test('a ticket taken in this sign-in is current, for the account and for a conversation', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    expect(t.engine.isCurrent(t.engine.ticket())).toBe(true)
    expect(t.engine.isCurrent(t.engine.ticket(CONV))).toBe(true)
    t.engine.stop()
  })

  test('a request made where no engine runs (a page outside the shell) is current while that is still so', async () => {
    const t = setup({ seed: 3 })
    const before = t.engine.ticket()
    expect(t.engine.isCurrent(before)).toBe(true)
    // …and it is not once the engine starts (the person went into the application), or the session ends.
    await open(t)
    expect(t.engine.isCurrent(before)).toBe(false)
    t.engine.stop()
    const again = t.engine.ticket()
    expect(t.engine.isCurrent(again)).toBe(true)
    t.engine.stop()
    expect(t.engine.isCurrent(again)).toBe(false)
  })

  test('another person signing in makes every earlier ticket stale, with the engine stopped in between or not', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const account = t.engine.ticket()
    const conversation = t.engine.ticket(CONV)
    await t.engine.start(accountB())
    expect(t.engine.isCurrent(account)).toBe(false)
    expect(t.engine.isCurrent(conversation)).toBe(false)
    const second = t.engine.ticket()
    t.engine.stop()
    await t.engine.start(makeAccount())
    expect(t.engine.isCurrent(second)).toBe(false)
    t.engine.stop()
  })

  test('the same person signing out and in again is not who asked either', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const account = t.engine.ticket()
    t.engine.stop()
    await t.engine.start(t.me)
    expect(t.engine.isCurrent(account)).toBe(false)
    t.engine.stop()
  })

  test('a password change under a live session moves the cache on, not the person: they are still who asked', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const account = t.engine.ticket()
    const conversation = t.engine.ticket(CONV)
    await t.engine.switchScope(makeAccount({ authEpoch: 2 }))
    // The cache refuses what was asked under the old generation (it is read again), the screen still gets its answer.
    expect(t.engine.isCurrent(account)).toBe(true)
    expect(t.engine.isCurrent(conversation)).toBe(true)
    t.engine.stop()
  })

  test('a membership that ended and began again is not the one the request was about; one about the account still is', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const account = t.engine.ticket()
    const conversation = t.engine.ticket(CONV)
    t.engine.ingestConversation(joinedAs(M2), t.engine.ticket())
    expect(t.engine.isCurrent(conversation)).toBe(false)
    expect(t.engine.isCurrent(account)).toBe(true)
    t.engine.stop()
  })

  test('a conversation that left the cache is not the one the request was about', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const conversation = t.engine.ticket(CONV)
    t.engine.leftConversation(CONV, t.engine.ticket(CONV))
    expect(t.engine.isCurrent(conversation)).toBe(false)
    t.engine.stop()
  })

  test('a write of the person who signed out, answered after somebody else signed in, is null and puts nothing into the cache', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const forScreen = screenWrites(t.engine)
    const answer = defer<Conversation>()
    const joinedLater = joinedAs(M2)
    const write = forScreen(
      null,
      () => answer.promise,
      (conversation, ticket) => t.engine.ingestConversation(conversation, ticket),
    )
    t.engine.stop()
    t.server.conversation = makeConversation(500, { me: makeMe({ membershipId: M2 }) })
    await t.engine.start(accountB())
    const before = JSON.stringify(t.index())
    answer.resolve(joinedLater)
    expect(await write).toBeNull()
    expect(JSON.stringify(t.index())).toBe(before)
    t.engine.stop()
  })

  test('a failure of such a write is swallowed, one of a write whose person is still here is not', async () => {
    const t = setup({ seed: 3 })
    await open(t)
    const forScreen = screenWrites(t.engine)
    let fail: (error: unknown) => void = () => undefined
    const stale = forScreen(
      CONV,
      () =>
        new Promise<never>((_resolve, reject) => {
          fail = reject
        }),
    )
    t.engine.stop()
    await t.engine.start(accountB())
    fail(new ApiError(0, 'NETWORK'))
    expect(await stale).toBeNull()
    const here = forScreen(null, () => Promise.reject(new ApiError(0, 'NETWORK')))
    await expect(here).rejects.toBeInstanceOf(ApiError)
    t.engine.stop()
  })
})
