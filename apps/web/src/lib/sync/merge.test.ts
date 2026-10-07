import { describe, expect, test } from 'vitest'
import { messageText } from '@/lib/message-text.ts'
import {
  edited,
  makeAccount,
  makeConversation,
  makeMe,
  makeMessage,
  makeUser,
  recalled,
  uuid,
} from './fixtures.ts'
import {
  applyRemoval,
  cascadeReplies,
  comparePreviewVersions,
  emptyIndex,
  forgetInIndex,
  mergeConversation,
  mergeMe,
  mergeMessage,
  mergeUsers,
  previewOf,
  raiseCounters,
} from './merge.ts'
import type { ConversationIndex } from './types.ts'

describe('mergeMessage', () => {
  test('a newer change replaces, an older or equal one does not', () => {
    const v2 = makeMessage(5, { changeSeq: 9, body: 'new' })
    const v1 = makeMessage(5, { changeSeq: 5, body: 'old' })
    expect(mergeMessage(v1, v2)).toBe(v2)
    expect(mergeMessage(v2, v1)).toBe(v2)
    const same = makeMessage(5, { changeSeq: 9, body: 'new' })
    expect(mergeMessage(v2, same)).toBe(v2)
  })

  test('with no current message the incoming one is taken', () => {
    const incoming = makeMessage(1)
    expect(mergeMessage(undefined, incoming)).toBe(incoming)
  })

  test('the same change with a newer stream revision wins (streaming messages, M4)', () => {
    const early = makeMessage(5, { changeSeq: 5, streamRevision: 1 })
    const later = makeMessage(5, { changeSeq: 5, streamRevision: 4 })
    expect(mergeMessage(early, later)).toBe(later)
    expect(mergeMessage(later, early)).toBe(later)
  })
})

describe('cascadeReplies', () => {
  const quoted = makeMessage(3, { body: 'original text' })
  const reply = makeMessage(7, {
    replyTo: {
      id: quoted.id,
      seq: 3,
      senderId: quoted.senderId,
      excerpt: 'original text',
      state: 'ok',
    },
  })
  const unrelated = makeMessage(8)

  test('an edit moves the excerpt of replies that quote it, to at most 100 code points', () => {
    const long = 'x'.repeat(150)
    const result = cascadeReplies([reply, unrelated], edited(quoted, 20, long))
    expect(result[0]?.replyTo).toMatchObject({ state: 'ok', excerpt: 'x'.repeat(100) })
    expect(result[1]).toBe(unrelated)
  })

  test('a recall and a deletion turn the quote into those states, without text', () => {
    const afterRecall = cascadeReplies([reply], recalled(quoted, 20))
    expect(afterRecall[0]?.replyTo).toMatchObject({ state: 'recalled', excerpt: null })
    const afterDelete = cascadeReplies([reply], {
      ...recalled(quoted, 21),
      recalledAt: null,
      deletedAt: '2026-10-04T08:00:00.000Z',
    })
    expect(afterDelete[0]?.replyTo).toMatchObject({ state: 'deleted', excerpt: null })
  })

  test('a message I hid reads "unavailable" in the replies that quote it', () => {
    const result = cascadeReplies([reply], { id: quoted.id, hidden: true })
    expect(result[0]?.replyTo).toEqual({ state: 'unavailable' })
  })

  test('nothing quoting the message means the very same array comes back', () => {
    const list = [unrelated]
    expect(cascadeReplies(list, edited(quoted, 20, 'changed'))).toBe(list)
  })

  test('a quote that already says what the change says is left alone', () => {
    const list = [reply]
    expect(cascadeReplies(list, quoted)).toBe(list)
  })

  test('replies that are already unavailable are not touched', () => {
    const hiddenQuote = makeMessage(9, { replyTo: { state: 'unavailable' } })
    const list = [hiddenQuote]
    expect(cascadeReplies(list, edited(quoted, 20, 'changed'))).toBe(list)
  })
})

describe('previewOf', () => {
  test('words the line the way the server does', () => {
    expect(previewOf(makeMessage(1, { body: 'hello' }))).toEqual({
      senderId: uuid(1),
      text: 'hello',
      kind: 'user',
      state: 'ok',
    })
    expect(previewOf(recalled(makeMessage(1), 2))).toMatchObject({ text: null, state: 'recalled' })
    expect(previewOf(makeMessage(1, { kind: 'system', body: null, senderId: null }))).toMatchObject(
      { text: null, state: 'ok', kind: 'system' },
    )
    expect(previewOf(makeMessage(1, { body: 'y'.repeat(300) })).text).toHaveLength(100)
  })
})

describe('mergeUsers', () => {
  test('a person is replaced only by a newer profile version', () => {
    const v1 = makeUser(2, { displayName: 'Old', profileVersion: 1 })
    const v2 = makeUser(2, { displayName: 'New', profileVersion: 2 })
    const dictionary = mergeUsers({}, [v1])
    expect(mergeUsers(dictionary, [v2])[uuid(2)]).toBe(v2)
    expect(mergeUsers({ [uuid(2)]: v2 }, [v1])[uuid(2)]).toBe(v2)
  })

  test('nothing new means the same dictionary object', () => {
    const user = makeUser(2)
    const dictionary = { [uuid(2)]: user }
    expect(mergeUsers(dictionary, [user])).toBe(dictionary)
    expect(mergeUsers(dictionary, { [uuid(2)]: user })).toBe(dictionary)
  })

  test('accepts a dictionary from a response as well as a list', () => {
    const merged = mergeUsers({}, { [uuid(2)]: makeUser(2), [uuid(3)]: makeUser(3) })
    expect(Object.keys(merged)).toHaveLength(2)
  })
})

describe('mergeMe', () => {
  const me = makeAccount()

  test('nobody signed in always wins', () => {
    expect(mergeMe(me, null)).toBeNull()
  })

  test('the first identity is taken', () => {
    expect(mergeMe(null, me)).toBe(me)
    expect(mergeMe(undefined, me)).toBe(me)
  })

  test('the same identity moves only forward in meVersion; an equal version is taken for the derived counters', () => {
    const newer = makeAccount({ meVersion: 4, displayName: 'Renamed' })
    expect(mergeMe(me, newer)).toBe(newer)
    expect(mergeMe(newer, me)).toBe(newer)
    const counters = makeAccount({ meVersion: 1, invitesUsed: 3 })
    expect(mergeMe(me, counters)).toBe(counters)
  })

  test('a different login generation (password change) replaces even with a lower version', () => {
    const changed = makeAccount({ authEpoch: 2, meVersion: 1 })
    expect(mergeMe(makeAccount({ meVersion: 9 }), changed)).toBe(changed)
  })

  test('another account or another restore generation replaces too', () => {
    const other = makeAccount({ id: uuid(77) })
    expect(mergeMe(makeAccount({ meVersion: 9 }), other)).toBe(other)
    const restored = makeAccount({ restoreEpoch: 'r2' })
    expect(mergeMe(makeAccount({ meVersion: 9 }), restored)).toBe(restored)
  })
})

describe('comparePreviewVersions', () => {
  const v = (lastChangeSeq: number, viewerVersion: number) => ({ lastChangeSeq, viewerVersion })
  test('orders when one is at least as new in both parts, and says so otherwise', () => {
    expect(comparePreviewVersions(v(5, 2), v(5, 2))).toBe('same')
    expect(comparePreviewVersions(v(6, 2), v(5, 2))).toBe('newer')
    expect(comparePreviewVersions(v(5, 3), v(5, 2))).toBe('newer')
    expect(comparePreviewVersions(v(4, 2), v(5, 2))).toBe('older')
    expect(comparePreviewVersions(v(6, 1), v(5, 2))).toBe('incomparable')
    expect(comparePreviewVersions(v(4, 3), v(5, 2))).toBe('incomparable')
  })
})

describe('mergeConversation', () => {
  const start = (conversation = makeConversation(10)): ConversationIndex => ({
    ...emptyIndex(),
    byId: { [conversation.id]: conversation },
  })

  test('the first answer about a conversation is stored with its relation', () => {
    const incoming = makeConversation(10)
    const { index, effects } = mergeConversation(emptyIndex(), incoming)
    expect(index.byId[incoming.id]?.me).toEqual(incoming.me)
    expect(effects).toEqual([])
  })

  test('shared profile moves only by metadataVersion', () => {
    const current = makeConversation(10, { name: 'Current', metadataVersion: 5 })
    const stale = makeConversation(10, { name: 'Stale', metadataVersion: 4, memberCount: 99 })
    const fresh = makeConversation(10, { name: 'Fresh', metadataVersion: 6, memberCount: 7 })
    const kept = mergeConversation(start(current), stale).index
    expect(kept.byId[current.id]?.name).toBe('Current')
    expect(kept.byId[current.id]?.memberCount).toBe(2)
    const taken = mergeConversation(start(current), fresh).index
    expect(taken.byId[current.id]).toMatchObject({
      name: 'Fresh',
      memberCount: 7,
      metadataVersion: 6,
    })
  })

  test('my relation moves only by viewerVersion, and nothing else of it is touched by an older answer', () => {
    const current = makeConversation(10, {
      me: makeMe({ version: 5, lastReadSeq: 40, pinnedAt: null }),
    })
    const stale = makeConversation(10, {
      me: makeMe({ version: 4, lastReadSeq: 10, pinnedAt: 'x' }),
    })
    const fresh = makeConversation(10, {
      me: makeMe({ version: 6, lastReadSeq: 50, pinnedAt: '2026-10-04T08:00:00.000Z' }),
    })
    expect(mergeConversation(start(current), stale).index.byId[current.id]?.me?.lastReadSeq).toBe(
      40,
    )
    const taken = mergeConversation(start(current), fresh).index.byId[current.id]
    expect(taken?.me?.pinnedAt).not.toBeNull()
    expect(taken?.viewerVersion).toBe(6)
  })

  test('an answer without a relation never takes a cached relation away', () => {
    const current = makeConversation(10)
    const answer = makeConversation(10, { me: null, metadataVersion: 9, name: 'Renamed' })
    const merged = mergeConversation(start(current), answer).index.byId[current.id]
    expect(merged?.me).not.toBeNull()
    expect(merged?.name).toBe('Renamed')
  })

  test('counters move by lastChangeSeq, and lastSeq never goes down', () => {
    const current = makeConversation(10, { lastSeq: 9, lastChangeSeq: 12, lastMessageAt: 'a' })
    const stale = makeConversation(10, { lastSeq: 5, lastChangeSeq: 6, lastMessageAt: 'b' })
    const fresh = makeConversation(10, { lastSeq: 11, lastChangeSeq: 14, lastMessageAt: 'c' })
    expect(mergeConversation(start(current), stale).index.byId[current.id]).toMatchObject({
      lastSeq: 9,
      lastChangeSeq: 12,
      lastMessageAt: 'a',
    })
    expect(mergeConversation(start(current), fresh).index.byId[current.id]).toMatchObject({
      lastSeq: 11,
      lastChangeSeq: 14,
      lastMessageAt: 'c',
    })
  })

  test('a preview is replaced when its versions dominate and kept when they are older', () => {
    const current = makeConversation(10, {
      lastMessagePreview: { senderId: null, text: 'current', kind: 'user', state: 'ok' },
      previewVersion: { lastChangeSeq: 5, viewerVersion: 1 },
    })
    const older = makeConversation(10, {
      lastMessagePreview: { senderId: null, text: 'older', kind: 'user', state: 'ok' },
      previewVersion: { lastChangeSeq: 4, viewerVersion: 1 },
    })
    const newer = makeConversation(10, {
      lastMessagePreview: { senderId: null, text: 'newer', kind: 'user', state: 'ok' },
      previewVersion: { lastChangeSeq: 6, viewerVersion: 1 },
    })
    expect(
      mergeConversation(start(current), older).index.byId[current.id]?.lastMessagePreview?.text,
    ).toBe('current')
    expect(
      mergeConversation(start(current), newer).index.byId[current.id]?.lastMessagePreview?.text,
    ).toBe('newer')
  })

  test('two previews that cannot be ordered hide the preview and ask for a fresh read; a dominating one clears it', () => {
    const current = makeConversation(10, {
      previewVersion: { lastChangeSeq: 5, viewerVersion: 2 },
      lastMessagePreview: { senderId: null, text: 'current', kind: 'user', state: 'ok' },
    })
    const crossed = makeConversation(10, {
      previewVersion: { lastChangeSeq: 6, viewerVersion: 1 },
      lastMessagePreview: { senderId: null, text: 'crossed', kind: 'user', state: 'ok' },
    })
    const first = mergeConversation(start(current), crossed)
    expect(first.index.previewHidden[current.id]).toBe(true)
    expect(first.index.byId[current.id]?.lastMessagePreview?.text).toBe('current')
    expect(first.effects).toContainEqual({
      type: 'preview-incomparable',
      conversationId: current.id,
    })

    const settled = makeConversation(10, {
      previewVersion: { lastChangeSeq: 6, viewerVersion: 2 },
      lastMessagePreview: { senderId: null, text: 'settled', kind: 'user', state: 'ok' },
    })
    const second = mergeConversation(first.index, settled)
    expect(second.index.previewHidden[current.id]).toBeUndefined()
    expect(second.index.byId[current.id]?.lastMessagePreview?.text).toBe('settled')
  })

  test('the direct-message peer moves by its profile version', () => {
    const current = makeConversation(10, {
      kind: 'dm',
      dmPeer: makeUser(2, { displayName: 'Old', profileVersion: 3 }),
    })
    const stale = makeConversation(10, {
      kind: 'dm',
      dmPeer: makeUser(2, { displayName: 'Stale', profileVersion: 2 }),
    })
    const fresh = makeConversation(10, {
      kind: 'dm',
      dmPeer: makeUser(2, { displayName: 'Fresh', profileVersion: 4 }),
    })
    expect(
      mergeConversation(start(current), stale).index.byId[current.id]?.dmPeer?.displayName,
    ).toBe('Old')
    expect(
      mergeConversation(start(current), fresh).index.byId[current.id]?.dmPeer?.displayName,
    ).toBe('Fresh')
  })

  test('an identical answer returns the same index object', () => {
    const current = makeConversation(10)
    const index = start(current)
    expect(mergeConversation(index, { ...current }).index).toBe(index)
  })

  test('a different membership (re-joined) is reported so its old cache can go in the same step', () => {
    const current = makeConversation(10, { me: makeMe({ version: 3, membershipId: uuid(701) }) })
    const rejoined = makeConversation(10, { me: makeMe({ version: 5, membershipId: uuid(702) }) })
    const { index, effects } = mergeConversation(start(current), rejoined)
    expect(effects).toContainEqual({
      type: 'membership-changed',
      conversationId: current.id,
      from: uuid(701),
      to: uuid(702),
    })
    expect(index.byId[current.id]?.me?.membershipId).toBe(uuid(702))
  })

  describe('after a removal I know of', () => {
    const gone = makeConversation(10)
    const removedIndex = (): ConversationIndex =>
      forgetInIndex(start(gone), gone.id, {
        viewerVersion: 8,
        membershipId: gone.me?.membershipId ?? null,
      })

    test('a relation from before the removal does not bring the conversation back as mine', () => {
      const stale = makeConversation(10, { me: makeMe({ version: 7 }) })
      const { index } = mergeConversation(removedIndex(), stale)
      expect(index.byId[gone.id]?.me ?? null).toBeNull()
      expect(index.removed[gone.id]).toBeDefined()
    })

    test('a relation newer than the removal is a re-join: accepted, and the marker is cleared', () => {
      const rejoined = makeConversation(10, {
        me: makeMe({ version: 12, membershipId: uuid(703) }),
      })
      const { index } = mergeConversation(removedIndex(), rejoined)
      expect(index.byId[gone.id]?.me?.membershipId).toBe(uuid(703))
      expect(index.removed[gone.id]).toBeUndefined()
    })

    test('shared data may still update, and an answer without a relation changes nothing about it', () => {
      const profile = makeConversation(10, { me: null, name: 'Renamed', metadataVersion: 9 })
      const { index } = mergeConversation(removedIndex(), profile)
      expect(index.byId[gone.id]?.name).toBe('Renamed')
      expect(index.byId[gone.id]?.me).toBeNull()
      expect(index.removed[gone.id]).toBeDefined()
    })
  })
})

describe('raiseCounters', () => {
  test('only ever raises, and the preview needs a dominating version', () => {
    const current = makeConversation(10, { lastSeq: 5, lastChangeSeq: 8, lastMessageAt: 'a' })
    const index = { ...emptyIndex(), byId: { [current.id]: current } }
    const raised = raiseCounters(
      index,
      current.id,
      { lastSeq: 7, lastChangeSeq: 10, lastMessageAt: 'b' },
      {
        preview: { senderId: null, text: 'derived', kind: 'user', state: 'ok' },
        version: { lastChangeSeq: 10, viewerVersion: 1 },
      },
    )
    expect(raised.byId[current.id]).toMatchObject({
      lastSeq: 7,
      lastChangeSeq: 10,
      lastMessageAt: 'b',
    })
    expect(raised.byId[current.id]?.lastMessagePreview?.text).toBe('derived')

    const lowered = raiseCounters(raised, current.id, {
      lastSeq: 1,
      lastChangeSeq: 2,
      lastMessageAt: 'z',
    })
    expect(lowered).toBe(raised)
  })

  test('an unknown conversation is left alone', () => {
    const index = emptyIndex()
    expect(
      raiseCounters(index, uuid(1), { lastSeq: 1, lastChangeSeq: 1, lastMessageAt: null }),
    ).toBe(index)
  })
})

describe('applyRemoval', () => {
  test('a tombstone newer than my relation, about the same membership, ends it', () => {
    const current = makeConversation(10, { me: makeMe({ version: 5, membershipId: uuid(701) }) })
    const index = { ...emptyIndex(), byId: { [current.id]: current } }
    const result = applyRemoval(index, {
      conversationId: current.id,
      membershipId: uuid(701),
      viewerVersion: 6,
    })
    expect(result.forget).toBe(true)
    expect(result.index.byId[current.id]).toBeUndefined()
    expect(result.index.removed[current.id]).toEqual({ viewerVersion: 6, membershipId: uuid(701) })
  })

  test('a late tombstone older than a re-join does not delete the new relation', () => {
    const current = makeConversation(10, { me: makeMe({ version: 9, membershipId: uuid(702) }) })
    const index = { ...emptyIndex(), byId: { [current.id]: current } }
    const result = applyRemoval(index, {
      conversationId: current.id,
      membershipId: uuid(701),
      viewerVersion: 6,
    })
    expect(result.forget).toBe(false)
    expect(result.index).toBe(index)
  })

  test('a tombstone for another membership than the cached one does not delete it either', () => {
    const current = makeConversation(10, { me: makeMe({ version: 5, membershipId: uuid(701) }) })
    const index = { ...emptyIndex(), byId: { [current.id]: current } }
    const result = applyRemoval(index, {
      conversationId: current.id,
      membershipId: uuid(799),
      viewerVersion: 7,
    })
    expect(result.forget).toBe(false)
  })

  test('with no cached relation the tombstone is only remembered, and repeating it changes nothing', () => {
    const index = emptyIndex()
    const first = applyRemoval(index, {
      conversationId: uuid(10),
      membershipId: null,
      viewerVersion: 4,
    })
    expect(first.forget).toBe(false)
    expect(first.index.removed[uuid(10)]).toEqual({ viewerVersion: 4, membershipId: null })
    const again = applyRemoval(first.index, {
      conversationId: uuid(10),
      membershipId: null,
      viewerVersion: 4,
    })
    expect(again.index).toBe(first.index)
  })
})

test('R1: source edits and optimistic previews never truncate inside mention ids', () => {
  const user = makeUser(2, { displayName: 'Bea' })
  const source = makeMessage(3, {
    body: `${'x'.repeat(90)}<@user:${user.id}> suffix`,
    changeSeq: 20,
  })
  const reply = makeMessage(7, {
    replyTo: {
      id: source.id,
      seq: source.seq,
      senderId: source.senderId,
      state: 'ok',
      excerpt: 'old',
    },
  })
  const quote = cascadeReplies([reply], source)[0]?.replyTo
  if (!quote || !('id' in quote)) throw new Error('quote missing')
  expect(messageText(quote.excerpt, { [user.id]: user })).toBe(`${'x'.repeat(90)}@Bea suffi`)
  expect(messageText(previewOf(source).text, { [user.id]: user })).not.toContain('<@user:')
})
