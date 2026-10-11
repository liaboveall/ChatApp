import type { MessageEnvelope, ReplayMessageRequest, SendMessageRequest } from '@chatapp/contracts'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../api.ts'
import { makeMessage, uuid } from './fixtures.ts'
import { Outbox, type OutboxDeps, type PendingMessage, pendingOf, useOutbox } from './outbox.ts'
import { clearClientStores } from './stores.ts'

const C = uuid(500)
const M = uuid(700)

type Call = {
  conversationId: string
  request: SendMessageRequest
  resolve: () => void
  reject: (e: unknown) => void
}

function setup(overrides: Partial<OutboxDeps> = {}) {
  const calls: Call[] = []
  const sent: MessageEnvelope[] = []
  let counter = 0
  const deps: OutboxDeps = {
    send: (conversationId, request) =>
      new Promise<MessageEnvelope>((resolve, reject) => {
        calls.push({
          conversationId,
          request,
          resolve: () =>
            resolve({
              message: makeMessage(calls.length, { body: request.body ?? null }),
              users: {},
            }),
          reject,
        })
      }),
    ticket: (conversationId) => ({
      scope: null,
      session: 0,
      conversationId,
      membershipId: M,
      watermark: 0,
    }),
    onSent: (envelope) => sent.push(envelope),
    onAccessError: () => false,
    membershipOf: () => M,
    now: () => Date.parse('2026-10-04T08:00:00.000Z'),
    newId: () => uuid(9000 + ++counter),
    ...overrides,
  }
  return { outbox: new Outbox(deps), calls, sent }
}

const list = (conversationId = C) => pendingOf(useOutbox.getState(), conversationId)
const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => clearClientStores())
afterEach(() => clearClientStores())

describe('Outbox', () => {
  test('a message shows up at once as sending and goes out with its own client id', async () => {
    const { outbox, calls } = setup()
    const pending = outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'hi',
      replyToId: null,
      quote: null,
    })
    expect(list()).toHaveLength(1)
    expect(list()[0]).toMatchObject({ clientId: pending.clientId, state: 'sending', error: null })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.request).toEqual({ clientId: pending.clientId, body: 'hi' })
  })

  test('one at a time and in the order they were typed', async () => {
    const { outbox, calls, sent } = setup()
    outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'one',
      replyToId: null,
      quote: null,
    })
    outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'two',
      replyToId: null,
      quote: null,
    })
    outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'three',
      replyToId: null,
      quote: null,
    })
    expect(calls).toHaveLength(1)
    expect(list().map((p) => p.state)).toEqual(['sending', 'queued', 'queued'])
    calls[0]?.resolve()
    await flush()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.request.body).toBe('two')
    calls[1]?.resolve()
    await flush()
    calls[2]?.resolve()
    await flush()
    expect(sent.map((e) => e.message.body)).toEqual(['one', 'two', 'three'])
    expect(list()).toHaveLength(0)
  })

  test('conversations do not wait for each other', () => {
    const { outbox, calls } = setup()
    outbox.enqueue({ conversationId: C, membershipId: M, body: 'a', replyToId: null, quote: null })
    outbox.enqueue({
      conversationId: uuid(501),
      membershipId: M,
      body: 'b',
      replyToId: null,
      quote: null,
    })
    expect(calls).toHaveLength(2)
  })

  test('a reply carries the id of the message it answers', () => {
    const { outbox, calls } = setup()
    outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'yes',
      replyToId: uuid(77),
      quote: null,
    })
    expect(calls[0]?.request).toEqual(expect.objectContaining({ replyToId: uuid(77) }))
  })

  test('a failure marks that message failed with the error code; the ones behind it go on', async () => {
    const { outbox, calls } = setup()
    outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'one',
      replyToId: null,
      quote: null,
    })
    outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'two',
      replyToId: null,
      quote: null,
    })
    calls[0]?.reject(new ApiError(500, 'INTERNAL'))
    await flush()
    expect(list().map((p) => [p.body, p.state, p.error])).toEqual([
      ['one', 'failed', 'INTERNAL'],
      ['two', 'sending', null],
    ])
    expect(calls).toHaveLength(2)
  })

  test('retrying sends the same client id again, so the server can answer it as the same message', async () => {
    const { outbox, calls } = setup()
    const pending = outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'one',
      replyToId: null,
      quote: null,
    })
    calls[0]?.reject(new ApiError(0, 'NETWORK'))
    await flush()
    outbox.retry(pending.clientId, C)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.request.clientId).toBe(pending.clientId)
    expect(list()[0]?.state).toBe('sending')
  })

  test('retry does nothing for a message that is not failed', () => {
    const { outbox, calls } = setup()
    const pending = outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'one',
      replyToId: null,
      quote: null,
    })
    outbox.retry(pending.clientId, C)
    expect(calls).toHaveLength(1)
  })

  test('discarding removes only the local copy', async () => {
    const { outbox, calls } = setup()
    const pending = outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'one',
      replyToId: null,
      quote: null,
    })
    calls[0]?.reject(new ApiError(500, 'INTERNAL'))
    await flush()
    outbox.discard(pending.clientId, C)
    expect(list()).toHaveLength(0)
  })

  test('a message written under a membership that has ended is not sent on its own', async () => {
    const { outbox, calls } = setup({ membershipOf: () => uuid(701) })
    outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'old',
      replyToId: null,
      quote: null,
    })
    await flush()
    expect(calls).toHaveLength(0)
    expect(list()[0]).toMatchObject({ state: 'failed', error: 'MEMBERSHIP_CHANGED' })
  })

  test('retrying a message of an ended membership is a deliberate act: it is re-stamped with the current one', async () => {
    let current = uuid(701)
    const { outbox, calls } = setup({ membershipOf: () => current })
    const pending = outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'old',
      replyToId: null,
      quote: null,
    })
    await flush()
    outbox.retry(pending.clientId, C)
    expect(calls).toHaveLength(1)
    expect(list()[0]?.membershipId).toBe(current)
    current = uuid(702)
  })

  test('losing access clears the conversation’s line without showing a failure', async () => {
    const onAccessError = vi.fn(() => true)
    const { outbox, calls } = setup({ onAccessError })
    outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'one',
      replyToId: null,
      quote: null,
    })
    outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'two',
      replyToId: null,
      quote: null,
    })
    calls[0]?.reject(new ApiError(404, 'NOT_FOUND'))
    await flush()
    expect(onAccessError).toHaveBeenCalledWith(
      C,
      expect.any(ApiError),
      expect.objectContaining({ conversationId: C, membershipId: M }),
    )
    expect(list()).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  test('ending the session empties every line', () => {
    const { outbox } = setup()
    outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'one',
      replyToId: null,
      quote: null,
    })
    clearClientStores()
    expect(list()).toHaveLength(0)
  })

  test('the ticket is taken when a message goes out, once per attempt, and comes back with the answer', async () => {
    const tickets: Array<{ conversationId: string | null; watermark: number }> = []
    let watermark = 0
    const onSent = vi.fn()
    const { outbox, calls } = setup({
      ticket: (conversationId) => {
        watermark += 10
        const ticket = { scope: null, session: 0, conversationId, membershipId: M, watermark }
        tickets.push(ticket)
        return ticket
      },
      onSent,
    })
    const pending = outbox.enqueue({
      conversationId: C,
      membershipId: M,
      body: 'one',
      replyToId: null,
      quote: null,
    })
    calls[0]?.reject(new ApiError(0, 'NETWORK'))
    await flush()
    outbox.retry(pending.clientId, C)
    calls[1]?.resolve()
    await flush()
    expect(tickets.map((ticket) => ticket.watermark)).toEqual([10, 20])
    expect(onSent).toHaveBeenCalledTimes(1)
    expect(onSent.mock.calls[0]?.[1]).toBe(tickets[1])
  })
})

/**
 * M2b review 2026-10-05 (R3): clearing a line takes its message away while the request is out, and what that request brings
 * back belongs to what was cleared. Nothing of it may reach the cache, the read position or the line of whoever uses the
 * screen next.
 */
describe('a line that is cleared while a message is on its way', () => {
  const write = (outbox: Outbox, body: string, conversationId = C) =>
    outbox.enqueue({ conversationId, membershipId: M, body, replyToId: null, quote: null })

  test.each([
    ['the account ended', () => clearClientStores()],
    ['the conversation was forgotten', (outbox: Outbox) => outbox.clearConversation(C)],
    ['everything was cleared', (outbox: Outbox) => outbox.clearAll()],
  ])('the answer is dropped when %s', async (_why, clear) => {
    const { outbox, calls, sent } = setup()
    write(outbox, 'ACCOUNT_A_SECRET')
    clear(outbox)
    calls[0]?.resolve()
    await flush()
    expect(sent).toEqual([])
    expect(list()).toEqual([])
  })

  test('the failure is dropped too: it is not taken for an access error of whoever is here now', async () => {
    const onAccessError = vi.fn(() => true)
    const { outbox, calls } = setup({ onAccessError })
    write(outbox, 'ACCOUNT_A_SECRET')
    clearClientStores()
    // The next account writes in the same conversation while the first request is still out.
    write(outbox, 'ACCOUNT_B_MESSAGE')
    calls[0]?.reject(new ApiError(404, 'NOT_FOUND'))
    await flush()
    expect(onAccessError).not.toHaveBeenCalled()
    expect(list().map((entry) => [entry.body, entry.state])).toEqual([
      ['ACCOUNT_B_MESSAGE', 'sending'],
    ])
  })

  test('a message of the next account in the same conversation is not disturbed by the late answer', async () => {
    const { outbox, calls, sent } = setup()
    write(outbox, 'ACCOUNT_A_SECRET')
    clearClientStores()
    write(outbox, 'ACCOUNT_B_MESSAGE')
    expect(calls).toHaveLength(2)
    calls[0]?.resolve()
    await flush()
    expect(sent).toEqual([])
    expect(list().map((entry) => [entry.body, entry.state])).toEqual([
      ['ACCOUNT_B_MESSAGE', 'sending'],
    ])
    expect(calls).toHaveLength(2)
    calls[1]?.resolve()
    await flush()
    expect(sent.map((envelope) => envelope.message.body)).toEqual(['ACCOUNT_B_MESSAGE'])
    expect(list()).toEqual([])
  })

  test('one conversation’s line being cleared does not touch the answers of another', async () => {
    const { outbox, calls, sent } = setup()
    write(outbox, 'here')
    write(outbox, 'there', uuid(501))
    outbox.clearConversation(C)
    calls[0]?.resolve()
    calls[1]?.resolve()
    await flush()
    expect(sent.map((envelope) => envelope.message.body)).toEqual(['there'])
  })

  test('a message that is not cleared goes in as before, with the one that was behind it', async () => {
    const { outbox, calls, sent } = setup()
    write(outbox, 'one')
    write(outbox, 'two')
    calls[0]?.resolve()
    await flush()
    calls[1]?.resolve()
    await flush()
    expect(sent.map((envelope) => envelope.message.body)).toEqual(['one', 'two'])
    expect(list()).toEqual([])
  })
})

// ───────── Waiting for the network (M6, D-205) ─────────

const NOW = Date.parse('2026-10-09T08:00:00.000Z')
const HOUR = 60 * 60 * 1000

type Replay = {
  conversationId: string
  request: ReplayMessageRequest
  resolve: () => void
  reject: (e: unknown) => void
}

function queueSetup(
  options: {
    online?: boolean
    canQueue?: boolean
    verifyAccount?: () => Promise<boolean>
    verifyConversation?: (id: string) => Promise<void>
    onAccessError?: () => boolean
    membershipOf?: () => string | undefined
  } = {},
) {
  const state = { online: options.online ?? true, now: NOW }
  const sends: Call[] = []
  const replays: Replay[] = []
  const sent: Array<{ envelope: MessageEnvelope; via: 'send' | 'replay' }> = []
  const verified = { account: 0, conversations: [] as string[] }
  let counter = 0
  const envelopeFor = (n: number, body: string): MessageEnvelope => ({
    message: makeMessage(n, { body }),
    users: {},
  })
  const deps: OutboxDeps = {
    send: (conversationId, request) =>
      new Promise<MessageEnvelope>((resolve, reject) => {
        sends.push({
          conversationId,
          request,
          resolve: () => resolve(envelopeFor(sends.length, request.body ?? '')),
          reject,
        })
      }),
    ticket: (conversationId) => ({
      scope: null,
      session: 0,
      conversationId,
      membershipId: M,
      watermark: 0,
    }),
    onSent: (envelope, _ticket, via) => sent.push({ envelope, via }),
    onAccessError: options.onAccessError ?? (() => false),
    membershipOf: options.membershipOf ?? (() => M),
    now: () => state.now,
    newId: () => uuid(9000 + ++counter),
    queue: {
      replay: (conversationId, request) =>
        new Promise<MessageEnvelope>((resolve, reject) => {
          replays.push({
            conversationId,
            request,
            resolve: () => resolve(envelopeFor(100 + replays.length, request.body)),
            reject,
          })
        }),
      isOnline: () => state.online,
      canQueue: () => options.canQueue ?? true,
      verifyAccount: async () => {
        verified.account += 1
        return (await options.verifyAccount?.()) ?? true
      },
      verifyConversation: async (id) => {
        verified.conversations.push(id)
        await options.verifyConversation?.(id)
      },
      random: () => 0.5,
    },
  }
  return { outbox: new Outbox(deps), state, sends, replays, sent, verified }
}

const text = (body: string, extra: Partial<Parameters<Outbox['enqueue']>[0]> = {}) => ({
  conversationId: C,
  membershipId: M,
  body,
  replyToId: null,
  quote: null,
  ...extra,
})
const settle = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}
const states = (conversationId = C) =>
  pendingOf(useOutbox.getState(), conversationId).map((p) => [p.body, p.state, p.error])

describe('a message that has to wait for the network', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  test('written offline, it waits in its line, in order, and nothing is sent', async () => {
    const { outbox, sends, replays } = queueSetup({ online: false })
    outbox.enqueue(text('one'))
    outbox.enqueue(text('two'))
    await settle()
    expect(states()).toEqual([
      ['one', 'offline', null],
      ['two', 'offline', null],
    ])
    expect(sends).toHaveLength(0)
    expect(replays).toHaveLength(0)
  })

  test('back online, the account is asked for first, then the conversation, then the messages go one at a time in order', async () => {
    const { outbox, state, replays, sent, verified } = queueSetup({ online: false })
    outbox.enqueue(text('one', { replyToId: uuid(55) }))
    outbox.enqueue(text('two'))
    state.online = true
    void outbox.resume()
    await settle()

    expect(verified.account).toBe(1)
    expect(verified.conversations).toEqual([C])
    expect(replays).toHaveLength(1)
    // What the server is told: the same client id, when it was written, and the membership it was written under.
    expect(replays[0]?.request).toEqual({
      clientId: pendingOf(useOutbox.getState(), C)[0]?.clientId,
      body: 'one',
      replyToId: uuid(55),
      queuedAt: new Date(NOW).toISOString(),
      membershipId: M,
    })
    expect(states()).toEqual([
      ['one', 'sending', null],
      ['two', 'offline', null],
    ])

    replays[0]?.resolve()
    await settle()
    expect(replays).toHaveLength(2)
    expect(replays[1]?.request.body).toBe('two')
    expect(replays[1]?.request).not.toHaveProperty('replyToId')
    replays[1]?.resolve()
    await settle()
    expect(states()).toEqual([])
    // Sent by the queue, and said so: the screen must not count them as read.
    expect(sent.map((s) => s.via)).toEqual(['replay', 'replay'])
  })

  test('a send that never got an answer waits, with the ones behind it, and goes again through the queue with the same client id', async () => {
    const { outbox, sends, replays, state } = queueSetup()
    outbox.enqueue(text('one'))
    outbox.enqueue(text('two'))
    const firstId = pendingOf(useOutbox.getState(), C)[0]?.clientId
    sends[0]?.reject(new ApiError(0, 'NETWORK'))
    await settle()
    expect(states()).toEqual([
      ['one', 'offline', null],
      ['two', 'offline', null],
    ])
    expect(sends).toHaveLength(1)

    // The network is still down at the first look; the next one is five seconds later.
    state.online = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(replays).toHaveLength(0)
    state.online = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(replays).toHaveLength(1)
    expect(replays[0]?.request.clientId).toBe(firstId)
  })

  test('a bad gateway counts as no answer; a refusal of the server does not', async () => {
    const { outbox, sends } = queueSetup()
    outbox.enqueue(text('one'))
    sends[0]?.reject(new ApiError(502, 'GATEWAY'))
    await settle()
    expect(states()).toEqual([['one', 'offline', null]])

    outbox.discard(pendingOf(useOutbox.getState(), C)[0]?.clientId ?? '', C)
    outbox.enqueue(text('two'))
    sends[1]?.reject(new ApiError(403, 'FORBIDDEN'))
    await settle()
    expect(states()).toEqual([['two', 'failed', 'FORBIDDEN']])
  })

  test('what cannot wait is a failure as before: attachments, and the assistant’s conversations', async () => {
    const withFile = queueSetup({ online: false })
    withFile.outbox.enqueue(
      text('look', {
        attachments: [
          { id: uuid(77) } as unknown as NonNullable<PendingMessage['attachments']>[number],
        ],
      }),
    )
    await settle()
    expect(states()).toEqual([['look', 'sending', null]])
    withFile.sends[0]?.reject(new ApiError(0, 'NETWORK'))
    await settle()
    expect(states()).toEqual([['look', 'failed', 'NETWORK']])
    useOutbox.setState({ byConversation: {} })

    const assistant = queueSetup({ canQueue: false })
    assistant.outbox.enqueue(text('hello'))
    assistant.sends[0]?.reject(new ApiError(0, 'NETWORK'))
    await settle()
    expect(states()).toEqual([['hello', 'failed', 'NETWORK']])
  })

  test('a new message typed behind one that waits waits too, even when the network seems to be back', async () => {
    const { outbox, sends, replays } = queueSetup({
      verifyAccount: () => new Promise(() => undefined),
    })
    outbox.enqueue(text('one'))
    sends[0]?.reject(new ApiError(0, 'NETWORK'))
    await settle()
    outbox.enqueue(text('two'))
    await settle()
    expect(states()).toEqual([
      ['one', 'offline', null],
      ['two', 'offline', null],
    ])
    expect(sends).toHaveLength(1)
    expect(replays).toHaveLength(0)
  })

  test('another account on the line (or nobody): nothing is sent', async () => {
    const { outbox, state, replays, verified } = queueSetup({
      online: false,
      verifyAccount: async () => false,
    })
    outbox.enqueue(text('one'))
    state.online = true
    await outbox.resume()
    await settle()
    expect(verified.account).toBe(1)
    expect(verified.conversations).toEqual([])
    expect(replays).toHaveLength(0)
    expect(states()).toEqual([['one', 'offline', null]])
  })

  test('when the account cannot be asked for, nothing is sent and the look is repeated later', async () => {
    let answers = 0
    const { outbox, state, replays } = queueSetup({
      online: false,
      verifyAccount: async () => {
        answers += 1
        if (answers === 1) throw new ApiError(0, 'NETWORK')
        return true
      },
    })
    outbox.enqueue(text('one'))
    state.online = true
    await outbox.resume()
    await settle()
    expect(replays).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(replays).toHaveLength(1)
  })

  test('the conversation is read again before its messages go; if that fails they wait', async () => {
    let reads = 0
    const { outbox, state, replays } = queueSetup({
      online: false,
      verifyConversation: async () => {
        reads += 1
        if (reads === 1) throw new ApiError(0, 'NETWORK')
      },
    })
    outbox.enqueue(text('one'))
    state.online = true
    await outbox.resume()
    await settle()
    expect(replays).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(replays).toHaveLength(1)
  })

  test('a message older than 24 hours is not sent on its own; a younger one behind it is', async () => {
    const { outbox, state, replays } = queueSetup({ online: false })
    outbox.enqueue(text('old'))
    state.now = NOW + 20 * HOUR
    outbox.enqueue(text('young'))
    state.now = NOW + 25 * HOUR
    state.online = true
    await outbox.resume()
    await settle()
    expect(states()).toEqual([
      ['old', 'failed', 'QUEUE_EXPIRED'],
      ['young', 'sending', null],
    ])
    expect(replays.map((r) => r.request.body)).toEqual(['young'])
  })

  test('a message written under a membership that has ended is kept for the person, not sent', async () => {
    const { outbox, state, replays } = queueSetup({ online: false, membershipOf: () => uuid(701) })
    outbox.enqueue(text('old'))
    state.online = true
    await outbox.resume()
    await settle()
    expect(replays).toHaveLength(0)
    expect(states()).toEqual([['old', 'failed', 'MEMBERSHIP_CHANGED']])
  })

  test.each([
    [
      'too old for the server',
      new ApiError(403, 'WINDOW_EXPIRED', { details: { reason: 'queue_expired' } }),
      'QUEUE_EXPIRED',
    ],
    [
      'a different membership for the server',
      new ApiError(409, 'CONFLICT', { details: { reason: 'membership_changed' } }),
      'MEMBERSHIP_CHANGED',
    ],
    [
      'the assistant’s conversation',
      new ApiError(422, 'VALIDATION_FAILED', { details: { reason: 'agent_conversation' } }),
      'NOT_QUEUEABLE',
    ],
    ['a refusal of the message itself', new ApiError(403, 'FORBIDDEN'), 'FORBIDDEN'],
  ])(
    'refused by the server for %s: kept as failed (%s), and the next one still goes',
    async (_name, error, code) => {
      const { outbox, state, replays } = queueSetup({ online: false })
      outbox.enqueue(text('one'))
      outbox.enqueue(text('two'))
      state.online = true
      await outbox.resume()
      await settle()
      replays[0]?.reject(error)
      await settle()
      expect(states()).toEqual([
        ['one', 'failed', code],
        ['two', 'sending', null],
      ])
    },
  )

  test('trouble that says nothing about the message keeps it waiting, and the ones behind it wait for it', async () => {
    const { outbox, state, replays } = queueSetup({ online: false })
    outbox.enqueue(text('one'))
    outbox.enqueue(text('two'))
    state.online = true
    await outbox.resume()
    await settle()
    replays[0]?.reject(new ApiError(500, 'INTERNAL'))
    await settle()
    expect(states()).toEqual([
      ['one', 'offline', null],
      ['two', 'offline', null],
    ])
    expect(replays).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(replays).toHaveLength(2)
    expect(replays[1]?.request.body).toBe('one')
  })

  test('a server that asks for patience is given it', async () => {
    const { outbox, state, replays } = queueSetup({ online: false })
    outbox.enqueue(text('one'))
    state.online = true
    await outbox.resume()
    await settle()
    replays[0]?.reject(new ApiError(429, 'RATE_LIMITED', { retryAfterSeconds: 30 }))
    await settle()
    await vi.advanceTimersByTimeAsync(29_000)
    expect(replays).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(replays).toHaveLength(2)
  })

  test('the pause between looks doubles while it keeps failing, up to a minute', async () => {
    const { outbox, state, replays } = queueSetup({ online: false })
    outbox.enqueue(text('one'))
    state.online = true
    await outbox.resume()
    await settle()
    const waits: number[] = []
    for (let round = 0; round < 6; round += 1) {
      const before = replays.length
      replays.at(-1)?.reject(new ApiError(0, 'NETWORK'))
      await settle()
      let waited = 0
      while (replays.length === before) {
        await vi.advanceTimersByTimeAsync(1000)
        waited += 1000
        if (waited > 70_000) throw new Error('never looked again')
      }
      waits.push(waited)
    }
    expect(waits).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000])
  })

  test('losing the conversation while sending clears its line', async () => {
    const { outbox, state, replays } = queueSetup({ online: false, onAccessError: () => true })
    outbox.enqueue(text('one'))
    outbox.enqueue(text('two'))
    state.online = true
    await outbox.resume()
    await settle()
    replays[0]?.reject(new ApiError(404, 'NOT_FOUND'))
    await settle()
    expect(states()).toEqual([])
  })

  test('the line being cleared while a message is on its way drops the late answer', async () => {
    const { outbox, state, replays, sent } = queueSetup({ online: false })
    outbox.enqueue(text('one'))
    state.online = true
    await outbox.resume()
    await settle()
    outbox.clearAll()
    replays[0]?.resolve()
    await settle()
    expect(sent).toEqual([])
    expect(states()).toEqual([])
  })

  test('a look asked for during a look runs once more, and nothing is sent twice', async () => {
    const { outbox, state, replays } = queueSetup({ online: false })
    outbox.enqueue(text('one'))
    state.online = true
    const first = outbox.resume()
    void outbox.resume()
    void outbox.resume()
    await settle()
    expect(replays).toHaveLength(1)
    replays[0]?.resolve()
    await first
    await settle()
    expect(replays).toHaveLength(1)
    expect(states()).toEqual([])
  })

  test('a message that was on its way by the ordinary route finishes first; the queue goes after it', async () => {
    const { outbox, state, sends, replays } = queueSetup()
    outbox.enqueue(text('one'))
    state.online = false
    outbox.enqueue(text('two'))
    await settle()
    expect(states()).toEqual([
      ['one', 'sending', null],
      ['two', 'offline', null],
    ])
    state.online = true
    await outbox.resume()
    await settle()
    // `one` is still out: `two` does not overtake it.
    expect(replays).toHaveLength(0)
    sends[0]?.resolve()
    await settle()
    expect(replays.map((r) => r.request.body)).toEqual(['two'])
  })

  test('ending the session stops the looks', async () => {
    const { outbox, state, replays } = queueSetup({ online: false })
    outbox.enqueue(text('one'))
    state.online = true
    await outbox.resume()
    await settle()
    replays[0]?.reject(new ApiError(0, 'NETWORK'))
    await settle()
    outbox.clearAll()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(replays).toHaveLength(1)
  })
})

describe('messages kept from an earlier visit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  const kept = (
    n: number,
    body: string,
    createdAt: string,
    state: PendingMessage['state'] = 'offline',
  ): PendingMessage => ({
    clientId: uuid(8000 + n),
    conversationId: C,
    membershipId: M,
    body,
    replyToId: null,
    quote: null,
    createdAt,
    state,
    error: state === 'failed' ? 'QUEUE_EXPIRED' : null,
  })

  test('they come back in the order they were written, are not doubled, and go out after the checks', async () => {
    const { outbox, replays, verified } = queueSetup()
    const earlier = kept(1, 'first', new Date(NOW - 2 * HOUR).toISOString())
    const later = kept(2, 'second', new Date(NOW - HOUR).toISOString())
    outbox.restore([later, earlier, earlier])
    await settle()
    expect(verified.account).toBe(1)
    expect(replays.map((r) => r.request.body)).toEqual(['first'])
    expect(replays[0]?.request.queuedAt).toBe(earlier.createdAt)
    replays[0]?.resolve()
    await settle()
    expect(replays.map((r) => r.request.body)).toEqual(['first', 'second'])
  })

  test('a failed one comes back as it was and is not sent', async () => {
    const { outbox, replays } = queueSetup()
    outbox.restore([kept(1, 'stuck', new Date(NOW - 30 * HOUR).toISOString(), 'failed')])
    await settle()
    expect(replays).toHaveLength(0)
    expect(states()).toEqual([['stuck', 'failed', 'QUEUE_EXPIRED']])
  })

  test('one that is already in the line is not put in again', async () => {
    const { outbox } = queueSetup({ online: false })
    const pending = outbox.enqueue(text('mine'))
    outbox.restore([{ ...pending }])
    expect(states()).toEqual([['mine', 'offline', null]])
  })
})
