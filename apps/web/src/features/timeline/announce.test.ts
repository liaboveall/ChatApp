import type { Message } from '@chatapp/contracts'
import { describe, expect, test } from 'vitest'
import { makeMessage, recalled } from '@/lib/sync/fixtures.ts'
import { type AnnounceWords, announcementOf, incomingAfter, shorten } from './announce.ts'

const words: AnnounceWords = {
  one: (sender, text) => `${sender}: ${text}`,
  many: (count, sender, text) => `${count} new, latest from ${sender}: ${text}`,
}

describe('shorten', () => {
  test('collapses white space and keeps short text whole', () => {
    expect(shorten('  hello \n  world ')).toBe('hello world')
  })

  test('cuts long text on a character boundary and marks it', () => {
    const cut = shorten('周'.repeat(200), 10)
    expect([...cut]).toHaveLength(10)
    expect(cut.endsWith('…')).toBe(true)
    // An emoji made of several code units is never split in the middle.
    expect(shorten('😀'.repeat(20), 5)).toBe(`${'😀'.repeat(4)}…`)
  })
})

describe('incomingAfter', () => {
  const me = 'me'
  const name = (id: string | null): string => (id === null ? '?' : `user-${id}`)
  const msg = (seq: number, patch: Partial<Message> = {}): Message =>
    makeMessage(seq, { senderId: 'them', body: `text ${seq}`, ...patch })

  test('only what is newer than the last one seen', () => {
    const found = incomingAfter([msg(1), msg(2), msg(3)], 1, me, name)
    expect(found.map((entry) => entry.text)).toEqual(['text 2', 'text 3'])
  })

  test('not my own messages, system lines, recalled or deleted ones', () => {
    const found = incomingAfter(
      [
        msg(2, { senderId: me }),
        msg(3, { kind: 'system', senderId: null }),
        recalled(msg(4), 5),
        msg(6, { deletedAt: '2026-10-04T10:00:00.000Z', body: null }),
        msg(7),
      ],
      0,
      me,
      name,
    )
    expect(found.map((entry) => entry.text)).toEqual(['text 7'])
  })

  test('names the sender with the function it is given', () => {
    expect(incomingAfter([msg(2)], 0, me, name)[0]?.sender).toBe('user-them')
  })
})

describe('announcementOf', () => {
  test('nothing new is nothing said', () => {
    expect(announcementOf([], words)).toBe('')
  })

  test('one message is read as it is', () => {
    expect(announcementOf([{ sender: 'Ann', text: 'hi  there' }], words)).toBe('Ann: hi there')
  })

  test('several become one: the count and the latest', () => {
    expect(
      announcementOf(
        [
          { sender: 'Ann', text: 'one' },
          { sender: 'Bob', text: 'two' },
          { sender: 'Cy', text: 'three' },
        ],
        words,
      ),
    ).toBe('3 new, latest from Cy: three')
  })
})
