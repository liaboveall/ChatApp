import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  type ComposeMode,
  type EditMode,
  endCompose,
  liveTarget,
  modeOf,
  settleEdit,
  startEdit,
  startReply,
  useCompose,
} from './compose.ts'
import { draftOf, setDraft, useDrafts } from './drafts.ts'
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

/** The edit in progress under a membership, as a screen holds it when it sends the save. */
function editNow(conversationId: string, membershipId: string): EditMode {
  const mode: ComposeMode | undefined = modeNow(conversationId, membershipId)
  if (mode?.type !== 'edit') throw new Error('no edit in progress')
  return mode
}

const draftNow = (conversationId: string): string => draftOf(useDrafts.getState(), conversationId)

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

  test('the stash of an earlier membership is never handed to the next one', () => {
    startEdit(C, M1, source, 'typed under the first membership')
    expect(endCompose(C, M2)).toBeUndefined()
    expect(modeNow(C, M2)).toBeUndefined()
    // It is dropped with the conversation's other stores when its membership ends, not by an end under another one (R5).
    clearConversationStores(C)
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

describe('a reply or an edit is ended only by whoever started that very one (R5, D-173)', () => {
  test('ending under another membership changes nothing: the mode the conversation holds now stays', () => {
    startEdit(C, M2, source, 'typed under the second membership')
    expect(endCompose(C, M1)).toBeUndefined()
    expect(editNow(C, M2).stash).toBe('typed under the second membership')
  })

  test('ending under a membership that holds nothing here changes nothing else', () => {
    setDraft(C, 'a draft')
    expect(endCompose(C, M1)).toBeUndefined()
    expect(useCompose.getState().byConversation).toEqual({})
    expect(draftNow(C)).toBe('a draft')
  })

  test('ending names the start: a reply or an edit started after it is not ended by it', () => {
    startEdit(C, M1, source, 'typed before')
    const first = editNow(C, M1)
    startEdit(C, M1, makeMessage(4), 'half of the first edit')
    expect(endCompose(C, M1, first.serial)).toBeUndefined()
    expect(editNow(C, M1).message.id).toBe(makeMessage(4).id)
    expect(endCompose(C, M1, editNow(C, M1).serial)).toBe('typed before')
    expect(modeNow(C, M1)).toBeUndefined()
  })

  test('every start has a number of its own, the same message again included', () => {
    startEdit(C, M1, source, 'typed before')
    const first = editNow(C, M1)
    expect(endCompose(C, M1, first.serial)).toBe('typed before')
    startEdit(C, M1, source, 'typed before')
    expect(editNow(C, M1).serial).not.toBe(first.serial)
  })

  test('a reply has a number of its own too: leaving the edit it replaced does not end it', () => {
    startEdit(C, M1, source, 'typed before')
    const edit = editNow(C, M1)
    startReply(C, M1, makeMessage(4))
    expect(endCompose(C, M1, edit.serial)).toBeUndefined()
    expect(modeNow(C, M1)?.type).toBe('reply')
  })
})

describe('the save of an edit settles the edit it went out under (R5, D-173)', () => {
  const saved = edited(source, 50, 'the new text')

  /** Starts an edit over a draft and types the new text: what the screen holds when Enter is pressed. */
  function editing(stash = 'typed before'): EditMode {
    startEdit(C, M1, source, stash)
    setDraft(C, 'the new text')
    return editNow(C, M1)
  }

  test('puts back what was set aside and ends the edit when the field still holds what was sent', () => {
    const mode = editing()
    settleEdit(mode, 'the new text', saved)
    expect(modeNow(C, M1)).toBeUndefined()
    expect(draftNow(C)).toBe('typed before')
  })

  test('an edit that set aside an empty field leaves an empty one', () => {
    const mode = editing('')
    settleEdit(mode, 'the new text', saved)
    expect(modeNow(C, M1)).toBeUndefined()
    expect(draftNow(C)).toBe('')
  })

  test('what was typed while the save was out is the person’s: it stays, and the edit goes on from the version just saved', () => {
    const mode = editing()
    setDraft(C, 'the new text, and more')
    settleEdit(mode, 'the new text', saved)
    expect(draftNow(C)).toBe('the new text, and more')
    const now = editNow(C, M1)
    expect(now.message).toBe(saved)
    expect(now.stash).toBe('typed before')
    expect(now.serial).toBe(mode.serial)
    // The save of that text settles it in turn.
    settleEdit(now, 'the new text, and more', edited(source, 60, 'the new text, and more'))
    expect(modeNow(C, M1)).toBeUndefined()
    expect(draftNow(C)).toBe('typed before')
  })

  test('does nothing once the edit was left meanwhile: what is in the field now is not its', () => {
    const mode = editing()
    endCompose(C, M1, mode.serial)
    setDraft(C, 'typed after leaving')
    settleEdit(mode, 'the new text', saved)
    expect(draftNow(C)).toBe('typed after leaving')
    expect(modeNow(C, M1)).toBeUndefined()
  })

  test('does nothing when another edit was started under the same membership meanwhile', () => {
    const mode = editing()
    startEdit(C, M1, makeMessage(4), 'the stash of the first edit stays')
    setDraft(C, 'second edit text')
    settleEdit(mode, 'the new text', saved)
    expect(editNow(C, M1).message.id).toBe(makeMessage(4).id)
    expect(editNow(C, M1).stash).toBe('typed before')
    expect(draftNow(C)).toBe('second edit text')
  })

  test('does nothing once a reply replaced the edit', () => {
    const mode = editing()
    expect(startReply(C, M1, makeMessage(4))).toBe('typed before')
    setDraft(C, 'typed under the reply')
    settleEdit(mode, 'the new text', saved)
    expect(modeNow(C, M1)?.type).toBe('reply')
    expect(draftNow(C)).toBe('typed under the reply')
  })

  test('does nothing for another membership: the one that came after, or the account that came after', () => {
    const mode = editing()
    clearConversationStores(C)
    startEdit(C, M2, makeMessage(5), 'typed under the second')
    setDraft(C, 'the second one’s edit')
    settleEdit(mode, 'the new text', saved)
    expect(editNow(C, M2).stash).toBe('typed under the second')
    expect(draftNow(C)).toBe('the second one’s edit')
  })

  test('does nothing when the stores were emptied (the session ended) and somebody typed since', () => {
    const mode = editing()
    clearClientStores()
    setDraft(C, 'what the next person typed')
    settleEdit(mode, 'the new text', saved)
    expect(useCompose.getState().byConversation).toEqual({})
    expect(draftNow(C)).toBe('what the next person typed')
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
