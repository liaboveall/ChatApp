import { describe, expect, test } from 'vitest'
import { edited, makeMessage, recalled, run, uuid } from './fixtures.ts'
import {
  appendPage,
  emptyWindow,
  hideInWindow,
  mergeChanges,
  newestOf,
  prependPage,
  trimNewest,
  trimOldest,
  windowFromPage,
  windowRange,
} from './window.ts'

const C = uuid(500)
const M = uuid(700)
const seqs = (window: { messages: Array<{ seq: number }> }) => window.messages.map((m) => m.seq)
const attached = (from: number, to: number) =>
  windowFromPage(C, M, { messages: run(from, to), hasMoreBefore: from > 1, hasMoreAfter: false })

describe('windowFromPage', () => {
  test('keeps the page in seq order with its flags', () => {
    const window = windowFromPage(C, M, {
      messages: [makeMessage(3), makeMessage(1), makeMessage(2)],
      hasMoreBefore: true,
      hasMoreAfter: false,
    })
    expect(seqs(window)).toEqual([1, 2, 3])
    expect(window).toMatchObject({
      hasMoreBefore: true,
      hasMoreAfter: false,
      conversationId: C,
      membershipId: M,
    })
    expect(windowRange(window)).toEqual({ min: 1, max: 3 })
    expect(newestOf(window)?.seq).toBe(3)
  })

  test('messages I deleted for myself and tombstoned ones stay out, a newer version of a tombstoned one comes in', () => {
    const base = {
      hidden: { [makeMessage(2).id]: true as const },
      gone: { [makeMessage(3).id]: 10 },
    }
    const window = windowFromPage(
      C,
      M,
      {
        messages: [
          makeMessage(1),
          makeMessage(2),
          makeMessage(3, { changeSeq: 10 }),
          makeMessage(4),
        ],
        hasMoreBefore: false,
        hasMoreAfter: false,
      },
      base,
    )
    expect(seqs(window)).toEqual([1, 4])
    const revived = windowFromPage(
      C,
      M,
      { messages: [makeMessage(3, { changeSeq: 11 })], hasMoreBefore: false, hasMoreAfter: false },
      base,
    )
    expect(seqs(revived)).toEqual([3])
    expect(revived.gone[makeMessage(3).id]).toBeUndefined()
  })

  test('an empty window reports no range or newest message', () => {
    const empty = emptyWindow(C, M)
    expect(windowRange(empty)).toBeNull()
    expect(newestOf(empty)).toBeUndefined()
  })
})

describe('prependPage and appendPage', () => {
  test('an older page joins at the top and hasMoreBefore follows the page', () => {
    const window = attached(51, 60)
    const next = prependPage(window, {
      messages: run(41, 50),
      hasMoreBefore: true,
      hasMoreAfter: false,
    })
    expect(seqs(next)).toEqual(Array.from({ length: 20 }, (_, i) => 41 + i))
    expect(next.hasMoreBefore).toBe(true)
    expect(next.revision).toBe(window.revision + 1)
    const last = prependPage(next, {
      messages: run(1, 40),
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
    expect(last.hasMoreBefore).toBe(false)
    expect(last.messages).toHaveLength(60)
  })

  test('overlap with what the window already holds is folded by id, each by its version', () => {
    const window = attached(5, 8)
    const next = prependPage(window, {
      messages: [makeMessage(3), makeMessage(4), makeMessage(5, { changeSeq: 99, body: 'newer' })],
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
    expect(seqs(next)).toEqual([3, 4, 5, 6, 7, 8])
    expect(next.messages[2]?.body).toBe('newer')
  })

  test('a newer page joins at the bottom of a window that was loaded around a message', () => {
    const window = windowFromPage(C, M, {
      messages: run(40, 60),
      hasMoreBefore: true,
      hasMoreAfter: true,
    })
    const next = appendPage(window, {
      messages: run(61, 100),
      hasMoreBefore: true,
      hasMoreAfter: true,
    })
    expect(windowRange(next)).toEqual({ min: 40, max: 100 })
    expect(next.hasMoreAfter).toBe(true)
    const end = appendPage(next, {
      messages: run(101, 110),
      hasMoreBefore: true,
      hasMoreAfter: false,
    })
    expect(end.hasMoreAfter).toBe(false)
  })

  test('a page with nothing in it still updates the flag', () => {
    const window = attached(5, 8)
    const next = prependPage(window, { messages: [], hasMoreBefore: false, hasMoreAfter: false })
    expect(next.hasMoreBefore).toBe(false)
    expect(next.messages).toBe(window.messages)
  })
})

describe('mergeChanges', () => {
  test('a newer version replaces a message in place and an older one is ignored', () => {
    const window = attached(1, 5)
    const target = window.messages[2]
    expect(target).toBeDefined()
    const newer = edited(makeMessage(3), 40, 'edited text')
    const next = mergeChanges(window, [newer])
    expect(next.messages[2]?.body).toBe('edited text')
    expect(next.messages[1]).toBe(window.messages[1])
    const older = mergeChanges(next, [makeMessage(3, { changeSeq: 3 })])
    expect(older).toBe(next)
  })

  test('a message that extends an attached window is appended in order, one beyond an open end is not', () => {
    const window = attached(1, 5)
    const next = mergeChanges(window, [makeMessage(7), makeMessage(6)])
    expect(seqs(next)).toEqual([1, 2, 3, 4, 5, 6, 7])

    const detached = windowFromPage(C, M, {
      messages: run(1, 5),
      hasMoreBefore: false,
      hasMoreAfter: true,
    })
    expect(mergeChanges(detached, [makeMessage(9)])).toBe(detached)
  })

  test('a message above the window is ignored while there is more above, and taken when the window starts the conversation', () => {
    const open = windowFromPage(C, M, {
      messages: run(10, 15),
      hasMoreBefore: true,
      hasMoreAfter: false,
    })
    expect(mergeChanges(open, [makeMessage(3, { changeSeq: 50 })])).toBe(open)
    const closed = windowFromPage(C, M, {
      messages: run(10, 15),
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
    expect(seqs(mergeChanges(closed, [makeMessage(3)]))).toEqual([3, 10, 11, 12, 13, 14, 15])
  })

  test('a message that falls between two held ones is inserted where its seq puts it', () => {
    const window = windowFromPage(C, M, {
      messages: [makeMessage(1), makeMessage(2), makeMessage(4), makeMessage(5)],
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
    expect(seqs(mergeChanges(window, [makeMessage(3)]))).toEqual([1, 2, 3, 4, 5])
  })

  test('a tombstone removes the message and keeps a late older page from bringing it back', () => {
    const window = attached(1, 5)
    const victim = window.messages[2]
    expect(victim).toBeDefined()
    const next = mergeChanges(window, [], [{ id: victim?.id ?? '', changeSeq: 30 }])
    expect(seqs(next)).toEqual([1, 2, 4, 5])
    expect(next.gone[victim?.id ?? '']).toBe(30)
    // An old version (older page, same message) cannot return; a newer version can.
    const stale = mergeChanges(next, [makeMessage(3, { changeSeq: 3 })])
    expect(seqs(stale)).toEqual([1, 2, 4, 5])
    const back = mergeChanges(next, [makeMessage(3, { changeSeq: 31 })])
    expect(seqs(back)).toEqual([1, 2, 3, 4, 5])
    expect(back.gone[victim?.id ?? '']).toBeUndefined()
  })

  test('a tombstone older than the held version does nothing', () => {
    const window = mergeChanges(attached(1, 3), [edited(makeMessage(2), 40, 'fresh')])
    const victim = window.messages[1]
    const next = mergeChanges(window, [], [{ id: victim?.id ?? '', changeSeq: 20 }])
    expect(next).toBe(window)
  })

  test('a tombstone for something the window never held is remembered', () => {
    const window = attached(1, 3)
    const next = mergeChanges(window, [], [{ id: uuid(9999), changeSeq: 12 }])
    expect(seqs(next)).toEqual([1, 2, 3])
    expect(next.gone[uuid(9999)]).toBe(12)
  })

  test('quotes of a changed message follow it, even when the message itself is not in the window', () => {
    const quoted = makeMessage(3, { body: 'original' })
    const reply = makeMessage(40, {
      replyTo: {
        id: quoted.id,
        seq: 3,
        senderId: quoted.senderId,
        excerpt: 'original',
        state: 'ok',
      },
    })
    const window = windowFromPage(C, M, {
      messages: [reply],
      hasMoreBefore: true,
      hasMoreAfter: false,
    })
    const next = mergeChanges(window, [recalled(quoted, 90)])
    expect(next.messages).toHaveLength(1)
    expect(next.messages[0]?.replyTo).toMatchObject({ state: 'recalled', excerpt: null })
  })

  test('a message I deleted for myself never comes back through a change', () => {
    const window = hideInWindow(attached(1, 3), makeMessage(2).id)
    expect(mergeChanges(window, [makeMessage(2, { changeSeq: 99 })])).toBe(window)
  })

  test('applying the same changes twice leaves the same window (catch-up may repeat)', () => {
    const window = attached(1, 3)
    const items = [makeMessage(4), edited(makeMessage(2), 33, 'two')]
    const once = mergeChanges(window, items)
    const twice = mergeChanges(once, items)
    expect(twice).toBe(once)
  })

  test('nothing to apply returns the same window object', () => {
    const window = attached(1, 3)
    expect(mergeChanges(window, [])).toBe(window)
  })
})

describe('hideInWindow', () => {
  test('removes the message for good and turns quotes of it into "unavailable"', () => {
    const quoted = makeMessage(2)
    const reply = makeMessage(5, {
      replyTo: { id: quoted.id, seq: 2, senderId: quoted.senderId, excerpt: 'x', state: 'ok' },
    })
    const window = windowFromPage(C, M, {
      messages: [makeMessage(1), quoted, makeMessage(3), reply],
      hasMoreBefore: false,
      hasMoreAfter: false,
    })
    const next = hideInWindow(window, quoted.id)
    expect(seqs(next)).toEqual([1, 3, 5])
    expect(next.hidden[quoted.id]).toBe(true)
    expect(next.messages[2]?.replyTo).toEqual({ state: 'unavailable' })
    expect(hideInWindow(next, quoted.id)).toBe(next)
  })

  test('a message that is not in the window is still remembered as hidden', () => {
    const window = attached(1, 3)
    const next = hideInWindow(window, uuid(4242))
    expect(next.hidden[uuid(4242)]).toBe(true)
    expect(next.messages).toBe(window.messages)
  })
})

describe('trimming', () => {
  test('dropping the newest end detaches the window from the newest message', () => {
    const window = attached(1, 30)
    const next = trimNewest(window, 20)
    expect(seqs(next)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(next.hasMoreAfter).toBe(true)
    expect(trimNewest(window, 30)).toBe(window)
  })

  test('dropping the oldest end marks that there is more above', () => {
    const window = windowFromPage(C, M, {
      messages: run(1, 30),
      hasMoreBefore: false,
      hasMoreAfter: true,
    })
    const next = trimOldest(window, 20)
    expect(windowRange(next)).toEqual({ min: 11, max: 30 })
    expect(next.hasMoreBefore).toBe(true)
    expect(trimOldest(window, 30)).toBe(window)
  })
})
