import type { Member, MembersPage } from '@chatapp/contracts'
import { describe, expect, test } from 'vitest'
import { extendMemberList, startMemberList } from './member-list.ts'

const member = (n: number, version = 3): Member => ({
  user: {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    profileVersion: 1,
    username: `user${n}`,
    displayName: `User ${n}`,
    avatarUrl: null,
    isBot: false,
    deleted: false,
  },
  membershipVersion: version,
  role: 'member',
  membershipId: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  joinedAt: '2026-10-01T00:00:00.000Z',
  silencedUntil: null,
})

const page = (ids: number[], version: number, nextCursor: string | null): MembersPage => ({
  members: ids.map((n) => member(n, version)),
  membershipVersion: version,
  nextCursor,
})

describe('member list', () => {
  test('starts from the first page and remembers the version and the way on', () => {
    const list = startMemberList(page([1, 2], 3, 'next'))
    expect(list.version).toBe(3)
    expect(list.members.map((entry) => entry.user.username)).toEqual(['user1', 'user2'])
    expect(list.nextCursor).toBe('next')
  })

  test('appends the next page read under the same version', () => {
    const list = startMemberList(page([1, 2], 3, 'next'))
    const more = extendMemberList(list, page([3, 4], 3, null))
    expect(more?.members.map((entry) => entry.user.username)).toEqual([
      'user1',
      'user2',
      'user3',
      'user4',
    ])
    expect(more?.nextCursor).toBeNull()
  })

  test('refuses a page read under another version: the listing starts again', () => {
    const list = startMemberList(page([1, 2], 3, 'next'))
    expect(extendMemberList(list, page([3], 4, null))).toBeNull()
  })

  test('does not show somebody twice when pages overlap', () => {
    const list = startMemberList(page([1, 2], 3, 'next'))
    const more = extendMemberList(list, page([2, 3], 3, null))
    expect(more?.members.map((entry) => entry.user.username)).toEqual(['user1', 'user2', 'user3'])
  })
})
