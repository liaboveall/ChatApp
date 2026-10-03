/** The permission matrix of docs/01 section 5 as table-driven tests of the pure policy (SEC-02, L-04, L-21). */
import { describe, expect, test } from 'bun:test'
import type { ConversationKind, MemberRole } from '@chatapp/contracts'
import {
  type ActorFacts,
  type ConversationAction,
  type ConversationFacts,
  decide,
  refusal,
  type TargetFacts,
} from './authorize.ts'

const ME = 'me'

const conversation = (
  kind: ConversationKind,
  extra: Partial<ConversationFacts> = {},
): ConversationFacts => ({
  kind,
  archived: false,
  whoCanInvite: 'all_members',
  ownerId: null,
  ...extra,
})

type Who = MemberRole | 'none' | 'silenced'
const actor = (who: Who, siteRole: 'user' | 'admin' = 'user'): ActorFacts => ({
  userId: ME,
  siteRole,
  member:
    who === 'none'
      ? null
      : who === 'silenced'
        ? { role: 'member', silenced: true }
        : { role: who, silenced: false },
})

const run = (
  action: ConversationAction,
  c: ConversationFacts,
  a: ActorFacts,
  target?: TargetFacts,
) => decide(action, { conversation: c, actor: a, target })

const outcome = (
  action: ConversationAction,
  c: ConversationFacts,
  a: ActorFacts,
  target?: TargetFacts,
): string => {
  const decision = run(action, c, a, target)
  return decision.allowed ? 'ok' : `${decision.kind}:${decision.reason}`
}

describe('who can see a conversation at all (L-04, L-21, L-23)', () => {
  test('a private conversation does not exist for someone outside it, whatever they ask', () => {
    for (const kind of ['group', 'dm', 'agent'] as const) {
      for (const action of [
        'view',
        'read_messages',
        'send_message',
        'edit_message',
        'recall_message',
        'hide_message',
        'view_members',
      ] as const) {
        expect(outcome(action, conversation(kind), actor('none'))).toBe('not_found:not_found')
      }
    }
  })

  test('a channel is visible to everybody but its messages are for members only', () => {
    const channel = conversation('channel')
    expect(outcome('view', channel, actor('none'))).toBe('ok')
    expect(outcome('read_messages', channel, actor('none'))).toBe('forbidden:not_member')
    expect(outcome('send_message', channel, actor('none'))).toBe('forbidden:not_member')
    expect(outcome('view_members', channel, actor('none'))).toBe('forbidden:not_member')
    expect(outcome('read_messages', channel, actor('member'))).toBe('ok')
  })

  test('a site administrator manages channels and groups but never sees direct messages or agents', () => {
    expect(outcome('view', conversation('group'), actor('none', 'admin'))).toBe('ok')
    expect(outcome('view_members', conversation('group'), actor('none', 'admin'))).toBe('ok')
    expect(outcome('read_messages', conversation('group'), actor('none', 'admin'))).toBe(
      'forbidden:not_member',
    )
    expect(outcome('view', conversation('dm'), actor('none', 'admin'))).toBe('not_found:not_found')
    expect(outcome('view', conversation('agent'), actor('none', 'admin'))).toBe(
      'not_found:not_found',
    )
  })

  test('the owner of record of an archived group can find it even though they are no longer a member', () => {
    const archived = conversation('group', { archived: true, ownerId: ME })
    expect(outcome('view', archived, actor('none'))).toBe('ok')
    expect(outcome('restore', archived, actor('none'))).toBe('ok')
    expect(outcome('view', conversation('group', { ownerId: ME }), actor('none'))).toBe(
      'not_found:not_found',
    )
    expect(
      outcome(
        'restore',
        conversation('group', { archived: true, ownerId: 'someone-else' }),
        actor('none'),
      ),
    ).toBe('not_found:not_found')
  })
})

describe('sending, editing and recalling', () => {
  test('a member sends; a silenced member cannot send or edit but can recall their own', () => {
    const group = conversation('group')
    expect(outcome('send_message', group, actor('member'))).toBe('ok')
    expect(outcome('send_message', group, actor('silenced'))).toBe('forbidden:silenced')
    expect(outcome('edit_message', group, actor('silenced'))).toBe('forbidden:silenced')
    expect(outcome('recall_message', group, actor('silenced'))).toBe('ok')
  })

  test('an archived conversation is read-only', () => {
    const archived = conversation('group', { archived: true })
    expect(outcome('read_messages', archived, actor('member'))).toBe('ok')
    expect(outcome('hide_message', archived, actor('member'))).toBe('ok')
    for (const action of [
      'send_message',
      'edit_message',
      'recall_message',
      'update',
      'add_members',
      'transfer',
    ] as const) {
      expect(outcome(action, archived, actor('owner'))).toBe('conflict:archived')
    }
  })
})

describe('joining and leaving', () => {
  test('a channel is joined by oneself; a group never is', () => {
    expect(outcome('join', conversation('channel'), actor('none'))).toBe('ok')
    expect(outcome('join', conversation('channel', { archived: true }), actor('none'))).toBe(
      'conflict:archived',
    )
    expect(outcome('join', conversation('group'), actor('none', 'admin'))).toBe(
      'forbidden:join_requires_invitation',
    )
  })

  test('direct messages cannot be left; members of the others can', () => {
    expect(outcome('leave', conversation('dm'), actor('member'))).toBe('forbidden:cannot_leave')
    expect(outcome('leave', conversation('group'), actor('member'))).toBe('ok')
    expect(outcome('leave', conversation('channel'), actor('none'))).toBe('forbidden:not_member')
  })
})

describe('bringing people in (docs/01 section 4.2)', () => {
  test('members may add and invite unless the group says admins only', () => {
    const open = conversation('group')
    const closed = conversation('group', { whoCanInvite: 'admins_only' })
    expect(outcome('add_members', open, actor('member'))).toBe('ok')
    expect(outcome('create_invite', open, actor('member'))).toBe('ok')
    expect(outcome('add_members', closed, actor('member'))).toBe('forbidden:requires_admin')
    expect(outcome('create_invite', closed, actor('member'))).toBe('forbidden:requires_admin')
    expect(outcome('add_members', closed, actor('admin'))).toBe('ok')
    expect(outcome('create_invite', closed, actor('owner'))).toBe('ok')
  })

  test('a site administrator who is not a member cannot add people or create links', () => {
    expect(outcome('add_members', conversation('group'), actor('none', 'admin'))).toBe(
      'forbidden:not_member',
    )
    expect(outcome('create_invite', conversation('group'), actor('none', 'admin'))).toBe(
      'forbidden:not_member',
    )
  })

  test('invitation links exist for groups only', () => {
    expect(outcome('create_invite', conversation('channel'), actor('owner'))).toBe(
      'forbidden:not_applicable',
    )
    expect(outcome('add_members', conversation('dm'), actor('member'))).toBe(
      'forbidden:not_applicable',
    )
  })
})

describe('moderation matrix: who may act on whom', () => {
  type Row = [Who, 'user' | 'admin', TargetFacts, string]
  const cases: Record<'remove_member' | 'ban' | 'silence', Row[]> = {
    remove_member: [
      ['member', 'user', { role: 'member' }, 'forbidden:requires_admin'],
      ['admin', 'user', { role: 'member' }, 'ok'],
      ['admin', 'user', { role: 'admin' }, 'forbidden:cannot_target_admin'],
      ['admin', 'user', { role: 'owner' }, 'forbidden:cannot_target_owner'],
      ['owner', 'user', { role: 'member' }, 'ok'],
      ['owner', 'user', { role: 'admin' }, 'ok'],
      ['owner', 'user', { role: 'owner' }, 'forbidden:cannot_target_owner'],
      ['none', 'admin', { role: 'member' }, 'ok'],
      ['none', 'admin', { role: 'admin' }, 'ok'],
      ['none', 'admin', { role: 'owner' }, 'forbidden:cannot_target_owner'],
      ['member', 'admin', { role: 'admin' }, 'ok'],
    ],
    ban: [
      ['member', 'user', { role: 'member' }, 'forbidden:requires_admin'],
      ['admin', 'user', { role: 'member' }, 'ok'],
      // Banning somebody who is not (or no longer) in the conversation is allowed: a ban list can be filled in advance.
      ['admin', 'user', null, 'ok'],
      ['admin', 'user', { role: 'admin' }, 'forbidden:cannot_target_admin'],
      ['owner', 'user', { role: 'admin' }, 'ok'],
      ['none', 'admin', null, 'ok'],
      ['none', 'user', { role: 'member' }, 'not_found:not_found'],
    ],
    silence: [
      ['member', 'user', { role: 'member' }, 'forbidden:requires_admin'],
      ['admin', 'user', { role: 'member' }, 'ok'],
      ['admin', 'user', { role: 'admin' }, 'forbidden:cannot_target_admin'],
      ['owner', 'user', { role: 'admin' }, 'ok'],
      ['owner', 'user', { role: 'owner' }, 'forbidden:cannot_target_owner'],
      ['admin', 'user', null, 'forbidden:target_not_member'],
      ['none', 'admin', { role: 'member' }, 'ok'],
    ],
  }
  for (const [action, rows] of Object.entries(cases) as Array<[keyof typeof cases, Row[]]>) {
    for (const [who, siteRole, target, expected] of rows) {
      test(`${action}: ${who}${siteRole === 'admin' ? ' (site admin)' : ''} on ${target?.role ?? 'a non-member'} → ${expected}`, () => {
        expect(outcome(action, conversation('group'), actor(who, siteRole), target)).toBe(expected)
      })
    }
  }

  test('roles are the owner’s to give, and the owner role moves only by transfer', () => {
    const group = conversation('group')
    expect(outcome('change_role', group, actor('owner'), { role: 'member' })).toBe('ok')
    expect(outcome('change_role', group, actor('owner'), { role: 'admin' })).toBe('ok')
    expect(outcome('change_role', group, actor('owner'), { role: 'owner' })).toBe(
      'forbidden:cannot_target_owner',
    )
    expect(outcome('change_role', group, actor('owner'), null)).toBe('forbidden:target_not_member')
    expect(outcome('change_role', group, actor('admin'), { role: 'member' })).toBe(
      'forbidden:requires_owner',
    )
    expect(outcome('change_role', group, actor('none', 'admin'), { role: 'member' })).toBe(
      'forbidden:requires_owner',
    )
    expect(outcome('transfer', group, actor('owner'))).toBe('ok')
    expect(outcome('transfer', group, actor('admin'))).toBe('forbidden:requires_owner')
    expect(outcome('transfer', group, actor('none', 'admin'))).toBe('forbidden:requires_owner')
  })

  test('unbanning, renaming and settings need an administrator; a site administrator qualifies', () => {
    const group = conversation('group')
    expect(outcome('unban', group, actor('member'))).toBe('forbidden:requires_admin')
    expect(outcome('unban', group, actor('admin'))).toBe('ok')
    expect(outcome('unban', group, actor('none', 'admin'))).toBe('ok')
    expect(outcome('update', group, actor('member'))).toBe('forbidden:requires_admin')
    expect(outcome('update', group, actor('admin'))).toBe('ok')
    expect(outcome('update', group, actor('none', 'admin'))).toBe('ok')
    expect(outcome('update', conversation('dm'), actor('member'))).toBe('forbidden:not_applicable')
  })

  test('archiving belongs to the owner and the site administrator; deleting others’ messages to every administrator', () => {
    const group = conversation('group')
    expect(outcome('archive', group, actor('admin'))).toBe('forbidden:requires_owner')
    expect(outcome('archive', group, actor('owner'))).toBe('ok')
    expect(outcome('archive', group, actor('none', 'admin'))).toBe('ok')
    expect(outcome('delete_message_of_others', group, actor('member'))).toBe(
      'forbidden:requires_admin',
    )
    expect(outcome('delete_message_of_others', group, actor('admin'))).toBe('ok')
    expect(outcome('delete_message_of_others', group, actor('none', 'admin'))).toBe('ok')
    expect(outcome('delete_message_of_others', conversation('dm'), actor('member'))).toBe(
      'forbidden:not_applicable',
    )
  })

  test('restoring: the recorded owner or a site administrator, not just any member', () => {
    const archived = conversation('group', { archived: true, ownerId: 'someone-else' })
    expect(outcome('restore', archived, actor('member'))).toBe('forbidden:requires_owner')
    expect(outcome('restore', archived, actor('none', 'admin'))).toBe('ok')
    expect(outcome('restore', { ...archived, ownerId: ME }, actor('member'))).toBe('ok')
  })
})

describe('refusals become API errors', () => {
  test('not found is a 404 with no hint, the others carry the reason', () => {
    const missing = decide('view', { conversation: conversation('group'), actor: actor('none') })
    expect(missing.allowed).toBe(false)
    if (missing.allowed) return
    const hidden = refusal(missing)
    expect(hidden.status).toBe(404)
    expect(hidden.details).toBeUndefined()

    const denied = decide('send_message', {
      conversation: conversation('group'),
      actor: actor('silenced'),
    })
    if (denied.allowed) throw new Error('expected a refusal')
    expect(refusal(denied).status).toBe(403)
    expect(refusal(denied).details).toEqual({ reason: 'silenced' })

    const busy = decide('send_message', {
      conversation: conversation('group', { archived: true }),
      actor: actor('member'),
    })
    if (busy.allowed) throw new Error('expected a refusal')
    expect(refusal(busy).status).toBe(409)
    expect(refusal(busy).details).toEqual({ reason: 'archived' })
  })
})
