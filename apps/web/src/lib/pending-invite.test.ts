import { beforeEach, describe, expect, test } from 'vitest'
import {
  clearPendingInvite,
  PENDING_INVITE_TTL_MS,
  savePendingInvite,
  takePendingInvite,
} from './pending-invite.ts'

beforeEach(() => sessionStorage.clear())

describe('pending invite code', () => {
  test('is handed over once and then gone', () => {
    savePendingInvite('abc123', 1000)
    expect(takePendingInvite(2000)).toBe('abc123')
    expect(takePendingInvite(2000)).toBeNull()
  })

  test('is no good after fifteen minutes', () => {
    savePendingInvite('abc123', 1000)
    expect(takePendingInvite(1000 + PENDING_INVITE_TTL_MS + 1)).toBeNull()
  })

  test('is still good just inside the fifteen minutes', () => {
    savePendingInvite('abc123', 1000)
    expect(takePendingInvite(1000 + PENDING_INVITE_TTL_MS)).toBe('abc123')
  })

  test('a stale read still deletes it', () => {
    savePendingInvite('abc123', 1000)
    takePendingInvite(1000 + PENDING_INVITE_TTL_MS + 1)
    expect(sessionStorage.length).toBe(0)
  })

  test('clearing removes it without reading it', () => {
    savePendingInvite('abc123', 1000)
    clearPendingInvite()
    expect(takePendingInvite(1000)).toBeNull()
  })

  test('garbage in storage, or a time from the far future, is treated as nothing', () => {
    sessionStorage.setItem('chatapp.pending-invite', '{not json')
    expect(takePendingInvite(1000)).toBeNull()
    savePendingInvite('abc123', 10_000_000)
    expect(takePendingInvite(1000)).toBeNull()
  })

  test('nothing stored is nothing', () => {
    expect(takePendingInvite(1000)).toBeNull()
  })
})
