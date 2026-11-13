import { describe, expect, test } from 'vitest'
import { makeMessage } from '@/lib/sync/fixtures.ts'
import { bubbleShape } from './bubble-shape.ts'

const picture = {
  id: '00000000-0000-4000-8000-000000007001',
  version: 1,
  generation: 1,
  kind: 'image' as const,
  mime: 'image/png',
  name: 'a.png',
  sizeBytes: 10,
  width: 10,
  height: 10,
  durationMs: null,
  thumbhash: null,
  status: 'ready' as const,
  urls: { original: '/a.png', thumb: null, preview: null },
}
const file = { ...picture, kind: 'file' as const, mime: 'application/pdf', name: 'a.pdf' }
const quote = { state: 'unavailable' as const }

describe('bubbleShape', () => {
  test('words are a bubble', () => {
    expect(bubbleShape(makeMessage(1, { body: 'hello' }))).toBe('bubble')
    expect(bubbleShape(makeMessage(1, { body: 'ok 👍' }))).toBe('bubble')
  })

  test('one to three emoji and nothing else are drawn large', () => {
    for (const body of ['👍', ' 🎉 ', '👍🏽', '❤️', '👨‍👩‍👧', '🇸🇬', '😀😀😀']) {
      expect(bubbleShape(makeMessage(1, { body })), body).toBe('emoji')
    }
    expect(bubbleShape(makeMessage(1, { body: '😀😀😀😀' }))).toBe('bubble')
    expect(bubbleShape(makeMessage(1, { body: '1' }))).toBe('bubble')
    expect(bubbleShape(makeMessage(1, { body: '#' }))).toBe('bubble')
  })

  test('pictures without words are bare; with words, or with a file among them, they are in a bubble', () => {
    expect(bubbleShape(makeMessage(1, { body: '', attachments: [picture, picture] }))).toBe('media')
    expect(bubbleShape(makeMessage(1, { body: null, attachments: [picture] }))).toBe('media')
    expect(bubbleShape(makeMessage(1, { body: 'look', attachments: [picture] }))).toBe('bubble')
    expect(bubbleShape(makeMessage(1, { body: '', attachments: [picture, file] }))).toBe('bubble')
    expect(bubbleShape(makeMessage(1, { body: '👍', attachments: [picture] }))).toBe('bubble')
  })

  test('a reply, a reminder, and what the assistant or the system wrote always keep the bubble', () => {
    expect(bubbleShape(makeMessage(1, { body: '👍', replyTo: quote }))).toBe('bubble')
    expect(bubbleShape(makeMessage(1, { body: '', attachments: [picture], replyTo: quote }))).toBe(
      'bubble',
    )
    expect(bubbleShape(makeMessage(1, { body: '👍', kind: 'agent' }))).toBe('bubble')
    expect(
      bubbleShape(
        makeMessage(1, {
          body: '⏰',
          meta: { reminder: { reminderId: '00000000-0000-4000-8000-000000000009' } },
        }),
      ),
    ).toBe('bubble')
    expect(bubbleShape(makeMessage(1, { body: null, kind: 'system', senderId: null }))).toBe(
      'bubble',
    )
  })
})
