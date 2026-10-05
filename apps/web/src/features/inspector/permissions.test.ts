import { describe, expect, test } from 'vitest'
import {
  type Actor,
  anyMemberAction,
  type ConversationFacts,
  conversationPermissions,
  memberPermissions,
  noMemberPermissions,
} from './permissions.ts'

const group: ConversationFacts = { kind: 'group', archived: false, whoCanInvite: 'all_members' }
const channel: ConversationFacts = { kind: 'channel', archived: false, whoCanInvite: 'admins_only' }
const dm: ConversationFacts = { kind: 'dm', archived: false, whoCanInvite: 'all_members' }
const as = (role: Actor['role'], siteRole: Actor['siteRole'] = 'user'): Actor => ({
  role,
  siteRole,
})
const ME = 'me'

describe('conversationPermissions', () => {
  test('an owner of a group can do everything a group offers', () => {
    expect(conversationPermissions(group, as('owner'))).toEqual({
      update: true,
      addMembers: true,
      createInvite: true,
      seeInvites: true,
      revokeAnyInvite: true,
      seeBans: true,
      unban: true,
      transfer: true,
      archive: true,
      leave: true,
      member: true,
    })
  })

  test('an administrator changes settings and sees bans, but cannot transfer or archive', () => {
    expect(conversationPermissions(group, as('admin'))).toMatchObject({
      update: true,
      seeBans: true,
      unban: true,
      transfer: false,
      archive: false,
    })
  })

  test('a plain member may invite only where everybody may', () => {
    expect(conversationPermissions(group, as('member'))).toMatchObject({
      addMembers: true,
      createInvite: true,
      update: false,
      seeBans: false,
      revokeAnyInvite: false,
    })
    expect(
      conversationPermissions({ ...group, whoCanInvite: 'admins_only' }, as('member')),
    ).toMatchObject({
      addMembers: false,
      createInvite: false,
    })
  })

  test('links exist for groups only', () => {
    expect(conversationPermissions(channel, as('owner'))).toMatchObject({
      createInvite: false,
      seeInvites: false,
      addMembers: true,
    })
  })

  test('a direct message has none of this: only hiding, which is not leaving', () => {
    const permissions = conversationPermissions(dm, as('member'))
    expect(permissions).toMatchObject({
      update: false,
      addMembers: false,
      leave: false,
      archive: false,
      seeBans: false,
    })
  })

  test('an archived conversation is read-only: nothing that changes it is offered, but its owner may still leave', () => {
    expect(conversationPermissions({ ...group, archived: true }, as('owner'))).toMatchObject({
      update: false,
      addMembers: false,
      createInvite: false,
      transfer: false,
      archive: false,
      unban: false,
      leave: true,
    })
  })

  test('a site administrator who is not in the group manages it but cannot bring people in or leave', () => {
    expect(conversationPermissions(group, as(null, 'admin'))).toMatchObject({
      update: true,
      seeBans: true,
      archive: true,
      revokeAnyInvite: true,
      addMembers: false,
      createInvite: false,
      seeInvites: false,
      leave: false,
      member: false,
    })
  })
})

describe('memberPermissions', () => {
  const target = (role: 'owner' | 'admin' | 'member', userId = 'them') => ({ userId, role })

  test('an owner may act on admins and members, and give or take the administrator role', () => {
    expect(memberPermissions(group, as('owner'), target('member'), ME)).toEqual({
      remove: true,
      ban: true,
      silence: true,
      changeRole: true,
      transfer: true,
    })
    expect(memberPermissions(group, as('owner'), target('admin'), ME).remove).toBe(true)
  })

  test('an administrator may act on plain members only, and cannot change roles', () => {
    expect(memberPermissions(group, as('admin'), target('member'), ME)).toEqual({
      remove: true,
      ban: true,
      silence: true,
      changeRole: false,
      transfer: false,
    })
    expect(memberPermissions(group, as('admin'), target('admin'), ME)).toEqual(noMemberPermissions)
  })

  test('nobody acts on the owner or on themselves', () => {
    expect(memberPermissions(group, as('owner'), target('owner', ME), ME)).toEqual(
      noMemberPermissions,
    )
    expect(memberPermissions(group, as('admin'), target('owner'), ME)).toEqual(noMemberPermissions)
    expect(memberPermissions(group, as('owner'), target('member', ME), ME)).toEqual(
      noMemberPermissions,
    )
  })

  test('a plain member may do none of it', () => {
    expect(memberPermissions(group, as('member'), target('member'), ME)).toEqual({
      remove: false,
      ban: false,
      silence: false,
      changeRole: false,
      transfer: false,
    })
  })

  test('a site administrator outranks an administrator but cannot change roles', () => {
    expect(memberPermissions(group, as(null, 'admin'), target('admin'), ME)).toEqual({
      remove: true,
      ban: true,
      silence: true,
      changeRole: false,
      transfer: false,
    })
  })

  test('not in an archived conversation, and not in a direct message', () => {
    expect(
      memberPermissions({ ...group, archived: true }, as('owner'), target('member'), ME),
    ).toEqual(noMemberPermissions)
    expect(memberPermissions(dm, as('owner'), target('member'), ME)).toEqual(noMemberPermissions)
  })

  test('anyMemberAction tells whether a menu would be empty', () => {
    expect(anyMemberAction(noMemberPermissions)).toBe(false)
    expect(anyMemberAction({ ...noMemberPermissions, silence: true })).toBe(true)
  })
})
