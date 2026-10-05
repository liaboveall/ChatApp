import { describe, expect, test } from 'vitest'
import { inviteLink, inviteState, muteFromChoice, muteSelection, silenceUntil } from './presets.ts'

const NOW = Date.parse('2026-10-04T10:00:00.000Z')

describe('durations', () => {
  test('a silence ends the given time from now', () => {
    expect(silenceUntil('10m', NOW)).toBe('2026-10-04T10:10:00.000Z')
    expect(silenceUntil('1d', NOW)).toBe('2026-10-05T10:00:00.000Z')
    expect(silenceUntil('30d', NOW)).toBe('2026-11-03T10:00:00.000Z')
  })

  test('a mute is off, forever, or until a finite time', () => {
    expect(muteFromChoice('off', NOW)).toEqual({ mode: 'off' })
    expect(muteFromChoice('forever', NOW)).toEqual({ mode: 'forever' })
    expect(muteFromChoice('8h', NOW)).toEqual({ mode: 'until', until: '2026-10-04T18:00:00.000Z' })
  })

  test('the mute select shows the running mute, and a mute that ran out as off', () => {
    expect(muteSelection({ mode: 'forever' }, NOW)).toBe('forever')
    expect(muteSelection({ mode: 'until', until: '2026-10-04T18:00:00.000Z' }, NOW)).toBe('until')
    expect(muteSelection({ mode: 'until', until: '2026-10-04T09:00:00.000Z' }, NOW)).toBe('off')
  })
})

describe('invitation links', () => {
  test('the code goes after the hash', () => {
    expect(inviteLink('https://chat.example', 'abc')).toBe('https://chat.example/join#abc')
  })

  test('a link is active until it is revoked, expires or is used up', () => {
    const base = {
      revokedAt: null,
      expiresAt: '2026-10-11T10:00:00.000Z',
      maxUses: null,
      useCount: 4,
    }
    expect(inviteState(base, NOW)).toBe('active')
    expect(inviteState({ ...base, revokedAt: '2026-10-04T09:00:00.000Z' }, NOW)).toBe('revoked')
    expect(inviteState({ ...base, expiresAt: '2026-10-04T10:00:00.000Z' }, NOW)).toBe('expired')
    expect(inviteState({ ...base, maxUses: 4 }, NOW)).toBe('used_up')
    expect(inviteState({ ...base, maxUses: 5 }, NOW)).toBe('active')
  })
})
