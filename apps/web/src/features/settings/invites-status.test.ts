import type { Invite } from '@chatapp/contracts'
import { describe, expect, test } from 'vitest'
import { inviteStatus } from './invites-section.tsx'

const NOW = Date.parse('2026-10-03T00:00:00Z')
const invite = (change: Partial<Invite> = {}): Invite => ({
  id: '0198d0c0-0000-7000-8000-000000000001',
  note: null,
  maxUses: 1,
  useCount: 0,
  expiresAt: '2026-10-10T00:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-10-03T00:00:00.000Z',
  ...change,
})

describe('inviteStatus', () => {
  test('active, revoked, expired and used up, in that order of precedence', () => {
    expect(inviteStatus(invite(), NOW)).toBe('active')
    expect(inviteStatus(invite({ revokedAt: '2026-10-04T00:00:00.000Z', useCount: 1 }), NOW)).toBe(
      'revoked',
    )
    expect(inviteStatus(invite({ expiresAt: '2026-10-02T00:00:00.000Z' }), NOW)).toBe('expired')
    expect(inviteStatus(invite({ useCount: 1 }), NOW)).toBe('used')
    expect(inviteStatus(invite({ maxUses: null, useCount: 500 }), NOW)).toBe('active')
  })
})
