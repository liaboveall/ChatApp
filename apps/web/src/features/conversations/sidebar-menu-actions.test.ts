import type { Conversation, ConversationMe } from '@chatapp/contracts'
import { describe, expect, test } from 'vitest'
import { makeConversation, makeMe } from '@/lib/sync/fixtures.ts'
import { sidebarMenuActions } from './sidebar-menu-actions.ts'

const conversation = (
  patch: Partial<Omit<Conversation, 'me'>> = {},
  me: Partial<ConversationMe> = {},
): Conversation => makeConversation(1, { kind: 'group', ...patch, me: makeMe(me) })

describe('sidebarMenuActions', () => {
  test('a group member can pin, mute, mark as read and leave; a direct message can be hidden instead of left', () => {
    expect(sidebarMenuActions(conversation({ memberCount: 4 }), 3, false)).toEqual({
      pin: 'pin',
      mute: 'mute',
      markRead: true,
      hide: false,
      leave: true,
    })
    expect(
      sidebarMenuActions(conversation({ kind: 'dm', memberCount: 2 }), 0, false),
    ).toMatchObject({
      markRead: false,
      hide: true,
      leave: false,
    })
  })

  test('the choices turn around when it is already pinned or muted', () => {
    const pinned = conversation({}, { pinnedAt: '2026-10-04T10:00:00.000Z' })
    expect(sidebarMenuActions(pinned, 0, true)).toMatchObject({ pin: 'unpin', mute: 'unmute' })
  })

  test('an owner who still has company cannot leave from here; one who is alone can', () => {
    expect(
      sidebarMenuActions(conversation({ memberCount: 3 }, { role: 'owner' }), 0, false)?.leave,
    ).toBe(false)
    expect(
      sidebarMenuActions(conversation({ memberCount: 1 }, { role: 'owner' }), 0, false)?.leave,
    ).toBe(true)
  })

  test('somebody who is not in the conversation gets no menu', () => {
    expect(sidebarMenuActions(makeConversation(1, { me: null }), 0, false)).toBeNull()
  })
})
