import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { endCompose, liveTarget, modeOf, startEdit, startReply, useCompose } from './compose.ts'
import { edited, ISO, makeMessage, recalled, uuid } from './fixtures.ts'
import { clearClientStores, clearConversationStores, registerConversationReset } from './stores.ts'
import { hideInWindow, mergeChanges, windowFromPage } from './window.ts'

const C = uuid(500)
const OTHER = uuid(501)
const M1 = uuid(700)
const M2 = uuid(701)
const source = makeMessage(3, { body: 'the original' })

beforeEach(() => clearClientStores())
afterEach(() => clearClientStores())

const modeNow = (conversationId: string, membershipId: string | undefined) =>
  modeOf(useCompose.getState(), conversationId, membershipId)

describe('the reply or the edit in progress belongs to the membership it was started under', () => {
  test('is read under that membership and under no other', () => {
    startReply(C, M1, source)
    expect(modeNow(C, M1)?.type).toBe('reply')
    expect(modeNow(C, M2)).toBeUndefined()
    expect(modeNow(C, undefined)).toBeUndefined()
    expect(modeNow(OTHER, M1)).toBeUndefined()
  })

  test('answering a message while editing leaves the edit and hands its stash back', () => {
    startEdit(C, M1, source, 'typed before')
    expect(startReply(C, M1, makeMessage(4))).toBe('typed before')
    expect(modeNow(C, M1)?.type).toBe('reply')
  })

  test('editing again keeps the stash of the first edit, not the text of the edit in the field', () => {
    startEdit(C, M1, source, 'typed before')
    startEdit(C, M1, makeMessage(4), 'half of the first edit')
    expect(endCompose(C, M1)).toBe('typed before')
  })

  test('ending a reply returns nothing; ending an edit returns what was set aside', () => {
    startReply(C, M1, source)
    expect(endCompose(C, M1)).toBeUndefined()
    startEdit(C, M1, source, 'typed before')
    expect(endCompose(C, M1)).toBe('typed before')
    expect(modeNow(C, M1)).toBeUndefined()
  })

  test('the stash of an earlier membership is thrown away, never handed to the next one', () => {
    startEdit(C, M1, source, 'typed under the first membership')
    expect(endCompose(C, M2)).toBeUndefined()
    expect(useCompose.getState().byConversation[C]).toBeUndefined()
  })

  test('starting under a new membership does not inherit what the old one left', () => {
    startEdit(C, M1, source, 'typed under the first membership')
    expect(startReply(C, M2, makeMessage(4))).toBeUndefined()
    startEdit(C, M1, source, 'typed under the first membership')
    startEdit(C, M2, makeMessage(5), 'typed under the second')
    expect(endCompose(C, M2)).toBe('typed under the second')
  })
})

describe('one conversation’s stores are dropped from one place', () => {
  test('clearing a conversation drops its reply or edit with the stash, and only that conversation’s', () => {
    startEdit(C, M1, source, 'typed before')
    startReply(OTHER, M1, source)
    clearConversationStores(C)
    expect(useCompose.getState().byConversation[C]).toBeUndefined()
    expect(modeNow(OTHER, M1)?.type).toBe('reply')
  })

  test('ending the session drops everything', () => {
    startEdit(C, M1, source, 'typed before')
    startReply(OTHER, M1, source)
    clearClientStores()
    expect(useCompose.getState().byConversation).toEqual({})
  })

  test('a store registers once and is called with the conversation; the unsubscribe removes it', () => {
    const reset = vi.fn()
    const off = registerConversationReset(reset)
    clearConversationStores(C)
    expect(reset).toHaveBeenCalledWith(C)
    off()
    clearConversationStores(C)
    expect(reset).toHaveBeenCalledTimes(1)
  })
})

describe('what a reply or an edit stands on', () => {
  const reply = makeMessage(7, {
    replyTo: {
      id: source.id,
      seq: 3,
      senderId: source.senderId,
      excerpt: 'the original',
      state: 'ok',
    },
  })
  const held = () =>
    windowFromPage(uuid(500), M1, {
      messages: [source, reply],
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
  const mode = () => {
    startReply(C, M1, source)
    const started = modeNow(C, M1)
    if (started === undefined) throw new Error('no mode')
    return started
  }

  test('is the message as the window holds it now: an edit is followed', () => {
    const next = mergeChanges(held(), [edited(source, 50, 'the edited text')])
    expect(liveTarget(mode(), next)?.body).toBe('the edited text')
  })

  test('is no target any more once the message was recalled, deleted or hidden', () => {
    expect(liveTarget(mode(), mergeChanges(held(), [recalled(source, 50)]))).toBeNull()
    expect(
      liveTarget(
        mode(),
        mergeChanges(held(), [{ ...source, changeSeq: 60, body: null, deletedAt: ISO }]),
      ),
    ).toBeNull()
    expect(liveTarget(mode(), hideInWindow(held(), source.id))).toBeNull()
  })

  test('is no target when the message left the window by tombstone', () => {
    expect(
      liveTarget(mode(), mergeChanges(held(), [], [{ id: source.id, changeSeq: 70 }])),
    ).toBeNull()
  })

  test('is the copy taken when it began while the window does not hold the message, or there is no window', () => {
    const outside = windowFromPage(uuid(500), M1, {
      messages: [reply],
      hasMoreBefore: true,
      hasMoreAfter: false,
    })
    expect(liveTarget(mode(), outside)).toBe(source)
    expect(liveTarget(mode(), undefined)).toBe(source)
  })

  test('is the copy when another message has that place in the window (a different history)', () => {
    const other = windowFromPage(uuid(500), M1, {
      messages: [makeMessage(3, { id: uuid(4242), body: 'someone else' })],
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
    expect(liveTarget(mode(), other)).toBe(source)
  })
})
