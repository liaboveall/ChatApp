import type { Conversation } from '@chatapp/contracts'
import { describe, expect, test } from 'vitest'
import type { ConversationIndex } from './sync/types.ts'
import { mutedNow, unreadTotal } from './unread.ts'

const NOW = Date.UTC(2026, 9, 9, 12)

function conversation(
  id: string,
  extra: Partial<NonNullable<Conversation['me']>> & {
    lastSeq?: number
    archivedAt?: string | null
    panel?: string | null
  } = {},
): Conversation {
  const { lastSeq = 10, archivedAt = null, panel = null, ...me } = extra
  return {
    id,
    kind: 'group',
    name: id,
    lastSeq,
    archivedAt,
    panelForConversationId: panel,
    me: {
      lastReadSeq: 4,
      notifyLevel: 'mentions',
      mute: { mode: 'off' },
      hiddenAt: null,
      ...me,
    },
  } as unknown as Conversation
}
const indexOf = (...list: Conversation[]): ConversationIndex => ({
  byId: Object.fromEntries(list.map((c) => [c.id, c])),
  removed: {},
  previewHidden: {},
})

describe('the number in the title and on the icon', () => {
  test('adds up what is unread in the listed conversations', () => {
    expect(
      unreadTotal(indexOf(conversation('a'), conversation('b', { lastSeq: 7 })), {}, NOW),
    ).toBe(9)
  })

  test('leaves out muted, switched-off, hidden, archived and panel conversations', () => {
    const index = indexOf(
      conversation('listed'),
      conversation('muted', { mute: { mode: 'forever' } }),
      conversation('limited', {
        mute: { mode: 'until', until: new Date(NOW + 60_000).toISOString() },
      }),
      conversation('off', { notifyLevel: 'none' }),
      conversation('hidden', { hiddenAt: '2026-10-09T00:00:00.000Z' }),
      conversation('archived', { archivedAt: '2026-10-09T00:00:00.000Z' }),
      conversation('panel', { panel: 'x' }),
    )
    expect(unreadTotal(index, {}, NOW)).toBe(6)
  })

  test('a mute that has run out counts again', () => {
    const lapsed = conversation('lapsed', {
      mute: { mode: 'until', until: new Date(NOW - 1).toISOString() },
    })
    expect(mutedNow({ mode: 'until', until: new Date(NOW - 1).toISOString() }, NOW)).toBe(false)
    expect(unreadTotal(indexOf(lapsed), {}, NOW)).toBe(6)
  })

  test('what this client already claimed as read is not counted', () => {
    expect(unreadTotal(indexOf(conversation('a')), { a: 10 }, NOW)).toBe(0)
    expect(unreadTotal(indexOf(conversation('a')), { a: 8 }, NOW)).toBe(2)
  })
})
