import type { MessageEnvelope, SendMessageRequest } from '@chatapp/contracts'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ApiError } from '../api.ts'
import { makeMessage, uuid } from './fixtures.ts'
import { Outbox, type OutboxDeps, pendingOf, useOutbox } from './outbox.ts'
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
    expect(onAccessError).toHaveBeenCalledWith(C, expect.any(ApiError))
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
})
