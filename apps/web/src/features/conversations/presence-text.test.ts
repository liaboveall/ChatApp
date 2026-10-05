import { describe, expect, test } from 'vitest'
import { type PresenceWords, presenceText } from './presence-text.ts'

const words: PresenceWords = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
  lastSeen: (when) => `Last seen ${when}`,
}
const now = Date.parse('2026-10-04T12:00:00Z')

describe('presenceText', () => {
  test('says nothing until the server has answered for the person', () => {
    expect(presenceText(undefined, now, 'en', words)).toBeNull()
  })

  test('online and away are those words', () => {
    expect(
      presenceText({ userId: 'a', status: 'online', lastSeenAt: null }, now, 'en', words),
    ).toBe('Online')
    expect(presenceText({ userId: 'a', status: 'away', lastSeenAt: null }, now, 'en', words)).toBe(
      'Away',
    )
  })

  test('offline says when they were last here, or just offline when that is not known', () => {
    expect(
      presenceText(
        { userId: 'a', status: 'offline', lastSeenAt: '2026-10-04T11:55:00Z' },
        now,
        'en',
        words,
      ),
    ).toBe('Last seen 5 minutes ago')
    expect(
      presenceText({ userId: 'a', status: 'offline', lastSeenAt: null }, now, 'en', words),
    ).toBe('Offline')
  })
})
