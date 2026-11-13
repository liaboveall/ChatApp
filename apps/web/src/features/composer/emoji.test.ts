import { describe, expect, test } from 'vitest'
import { EMOJI_GROUPS, parseRecentEmoji, RECENT_EMOJI_MAX, withRecentEmoji } from './emoji.ts'

describe('the emoji groups', () => {
  test('no emoji is offered twice', () => {
    const all = EMOJI_GROUPS.flatMap((group) => group.emoji)
    expect(new Set(all).size).toBe(all.length)
  })

  test('every entry is one visible symbol', () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    for (const emoji of EMOJI_GROUPS.flatMap((group) => group.emoji)) {
      expect([...segmenter.segment(emoji)], emoji).toHaveLength(1)
    }
  })
})

describe('recently used emoji', () => {
  test('the newest comes first and is never listed twice', () => {
    expect(withRecentEmoji(['👍', '🎉'], '🎉')).toEqual(['🎉', '👍'])
    expect(withRecentEmoji(['👍'], '🔥')).toEqual(['🔥', '👍'])
  })

  test('only so many are kept', () => {
    let recent: string[] = []
    for (let index = 0; index < RECENT_EMOJI_MAX + 6; index += 1) {
      recent = withRecentEmoji(recent, String.fromCodePoint(0x1f600 + index))
    }
    expect(recent).toHaveLength(RECENT_EMOJI_MAX)
    expect(recent[0]).toBe(String.fromCodePoint(0x1f600 + RECENT_EMOJI_MAX + 5))
  })

  test('what was stored is read back, and anything else is nothing', () => {
    expect(parseRecentEmoji(JSON.stringify(['👍', '🎉']))).toEqual(['👍', '🎉'])
    expect(parseRecentEmoji(null)).toEqual([])
    expect(parseRecentEmoji('{broken')).toEqual([])
    expect(parseRecentEmoji('{"a":1}')).toEqual([])
    expect(parseRecentEmoji(JSON.stringify(['👍', 7, '', 'x'.repeat(40)]))).toEqual(['👍'])
  })
})
