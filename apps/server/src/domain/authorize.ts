/**
 * Who may do what in a conversation (docs/01 sections 4.4 and 5, SEC-02). `decide` is the whole policy as a pure
 * function of facts, so the permission matrix can be tested exhaustively; `requireAccess` reads the facts (under the
 * conversation lock when the caller writes) and turns a refusal into the API error:
 *
 *  - a private conversation (group, direct message, agent) that the caller cannot see answers 404, as if it did not exist;
 *  - a visible conversation in which the action is not allowed answers 403 (`forbidden`) or 409 (`conflict`, a state
 *    such as "archived" is in the way).
 */
import {
  AppError,
  type ConversationKind,
  type MemberRole,
  type WhoCanInvite,
} from '@chatapp/contracts'
import { conversationMembers, conversations, type DbOrTx } from '@chatapp/db'
import { and, eq } from 'drizzle-orm'

export type ConversationRow = typeof conversations.$inferSelect
export type MemberRow = typeof conversationMembers.$inferSelect

export type SiteRole = 'user' | 'admin'

export const CONVERSATION_ACTIONS = [
  'view',
  'view_members',
  'read_messages',
  'send_message',
  'edit_message',
  'recall_message',
  'hide_message',
  'set_preferences',
  'join',
  'leave',
  'update',
  'add_members',
  'create_invite',
  'revoke_any_invite',
  'remove_member',
  'ban',
  'unban',
  'silence',
  'change_role',
  'transfer',
  'archive',
  'restore',
  'delete_message_of_others',
] as const
export type ConversationAction = (typeof CONVERSATION_ACTIONS)[number]

export type ConversationFacts = {
  kind: ConversationKind
  archived: boolean
  whoCanInvite: WhoCanInvite
  /** The recorded owner; an archived conversation may have no member left but still has someone who can restore it. */
  ownerId: string | null
}

export type ActorFacts = {
  userId: string
  siteRole: SiteRole
  /** The actor's own membership; null when they are not in the conversation. */
  member: { role: MemberRole; silenced: boolean } | null
}

/** The person an action is aimed at; null when they are not a member. */
export type TargetFacts = { role: MemberRole } | null

export type Decision =
  | { allowed: true }
  | { allowed: false; kind: 'not_found' | 'forbidden' | 'conflict'; reason: string }

const ok: Decision = { allowed: true }
const notFound: Decision = { allowed: false, kind: 'not_found', reason: 'not_found' }
const forbidden = (reason: string): Decision => ({ allowed: false, kind: 'forbidden', reason })
const conflict = (reason: string): Decision => ({ allowed: false, kind: 'conflict', reason })

/** How much weight an actor's role carries over another member; a site administrator ranks above an admin, below an owner. */
const RANK: Record<MemberRole, number> = { member: 1, admin: 2, owner: 4 }
const SITE_ADMIN_RANK = 3

export function decide(
  action: ConversationAction,
  facts: { conversation: ConversationFacts; actor: ActorFacts; target?: TargetFacts },
): Decision {
  const { conversation: c, actor } = facts
  const member = actor.member
  const siteAdmin = actor.siteRole === 'admin'
  const managed = c.kind === 'channel' || c.kind === 'group'
  const ownerOfRecord = c.ownerId !== null && c.ownerId === actor.userId

  // Existence comes first: a conversation the caller may not know about does not exist for them.
  const visible =
    member !== null ||
    c.kind === 'channel' ||
    (c.kind === 'group' && (siteAdmin || (c.archived && ownerOfRecord)))
  if (!visible) return notFound

  const isOwner = member?.role === 'owner'
  const isAdminOrOwner = member?.role === 'admin' || isOwner
  const actorRank = Math.max(
    member ? RANK[member.role] : 0,
    siteAdmin && managed ? SITE_ADMIN_RANK : 0,
  )
  const needsMember = (): Decision | null => (member === null ? forbidden('not_member') : null)
  const needsLive = (): Decision | null => (c.archived ? conflict('archived') : null)

  switch (action) {
    case 'view':
      return ok

    case 'view_members':
      return member !== null || (siteAdmin && managed) ? ok : forbidden('not_member')

    case 'read_messages':
      return needsMember() ?? ok

    case 'send_message':
    case 'edit_message':
      return needsMember() ?? needsLive() ?? (member?.silenced ? forbidden('silenced') : ok)

    case 'recall_message':
      return needsMember() ?? needsLive() ?? ok

    case 'hide_message':
    case 'set_preferences':
      return needsMember() ?? ok

    case 'join':
      if (c.kind !== 'channel') return forbidden('join_requires_invitation')
      return needsLive() ?? ok

    case 'leave':
      if (member === null) return forbidden('not_member')
      if (!managed) return forbidden('cannot_leave')
      return needsLive() ?? ok

    case 'update':
      if (c.kind === 'agent') return isOwner ? (needsLive() ?? ok) : forbidden('requires_owner')
      if (!managed) return forbidden('not_applicable')
      if (!isAdminOrOwner && !siteAdmin) return forbidden('requires_admin')
      return needsLive() ?? ok

    case 'add_members':
    case 'create_invite': {
      if (action === 'create_invite' ? c.kind !== 'group' : !managed)
        return forbidden('not_applicable')
      // A site administrator is not a member and cannot bring people in (docs/01 section 5).
      if (member === null) return forbidden('not_member')
      const live = needsLive()
      if (live) return live
      if (isAdminOrOwner || c.whoCanInvite === 'all_members') return ok
      return forbidden('requires_admin')
    }

    case 'revoke_any_invite':
      return isAdminOrOwner || siteAdmin ? ok : forbidden('requires_admin')

    case 'remove_member':
    case 'ban': {
      if (!managed) return forbidden('not_applicable')
      const live = needsLive()
      if (live) return live
      const target = facts.target
      if (target?.role === 'owner') return forbidden('cannot_target_owner')
      if (actorRank < RANK.admin) return forbidden('requires_admin')
      // An admin can act on members only; an owner and a site administrator on admins too.
      if (target?.role === 'admin' && actorRank < SITE_ADMIN_RANK) {
        return forbidden('cannot_target_admin')
      }
      return ok
    }

    case 'unban':
      if (!managed) return forbidden('not_applicable')
      return isAdminOrOwner || siteAdmin ? (needsLive() ?? ok) : forbidden('requires_admin')

    case 'silence': {
      if (!managed) return forbidden('not_applicable')
      const live = needsLive()
      if (live) return live
      const target = facts.target
      if (!target) return forbidden('target_not_member')
      if (target.role === 'owner') return forbidden('cannot_target_owner')
      if (actorRank < RANK.admin) return forbidden('requires_admin')
      if (target.role === 'admin' && actorRank < SITE_ADMIN_RANK) {
        return forbidden('cannot_target_admin')
      }
      return ok
    }

    case 'change_role': {
      if (!managed) return forbidden('not_applicable')
      if (!isOwner) return forbidden('requires_owner')
      const live = needsLive()
      if (live) return live
      const target = facts.target
      if (!target) return forbidden('target_not_member')
      return target.role === 'owner' ? forbidden('cannot_target_owner') : ok
    }

    case 'transfer':
      if (!managed) return forbidden('not_applicable')
      if (!isOwner) return forbidden('requires_owner')
      return needsLive() ?? ok

    case 'archive':
      if (!managed) return forbidden('not_applicable')
      return isOwner || siteAdmin ? ok : forbidden('requires_owner')

    case 'restore':
      if (!managed) return forbidden('not_applicable')
      return ownerOfRecord || siteAdmin ? ok : forbidden('requires_owner')

    case 'delete_message_of_others':
      if (!managed) return forbidden('not_applicable')
      if (!isAdminOrOwner && !siteAdmin) return forbidden('requires_admin')
      return needsLive() ?? ok
  }
}

const REFUSAL_TEXT: Record<string, string> = {
  not_member: 'You are not a member of this conversation',
  silenced: 'You are silenced in this conversation',
  archived: 'The conversation is archived and read-only',
  requires_admin: 'This needs an administrator of the conversation',
  requires_owner: 'This needs the owner of the conversation',
  cannot_target_owner: 'The owner cannot be targeted; transfer ownership first',
  cannot_target_admin: 'Only the owner can act on an administrator',
  cannot_leave: 'This conversation cannot be left',
  join_requires_invitation: 'This conversation can only be joined by invitation or by being added',
  not_applicable: 'This does not apply to this kind of conversation',
  target_not_member: 'That person is not a member of this conversation',
}

export function refusal(decision: Extract<Decision, { allowed: false }>): AppError {
  if (decision.kind === 'not_found') return new AppError('NOT_FOUND', 'Conversation not found')
  const message = REFUSAL_TEXT[decision.reason] ?? 'Not allowed'
  return new AppError(decision.kind === 'conflict' ? 'CONFLICT' : 'FORBIDDEN', message, {
    details: { reason: decision.reason },
  })
}

export function conversationFacts(row: ConversationRow): ConversationFacts {
  return {
    kind: row.kind,
    archived: row.archivedAt !== null,
    whoCanInvite: row.settings.whoCanInvite ?? 'all_members',
    ownerId: row.ownerId,
  }
}

export function actorFacts(
  actor: { userId: string; siteRole: SiteRole },
  member: MemberRow | null,
  now: Date,
): ActorFacts {
  return {
    userId: actor.userId,
    siteRole: actor.siteRole,
    member: member
      ? { role: member.role, silenced: member.silencedUntil !== null && member.silencedUntil > now }
      : null,
  }
}

export type ConversationAccess = {
  conversation: ConversationRow
  member: MemberRow | null
  /** The membership of `targetUserId` when one was named. */
  target: MemberRow | null
}

export async function findMember(
  db: DbOrTx,
  conversationId: string,
  userId: string,
): Promise<MemberRow | null> {
  const [row] = await db
    .select()
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Loads the conversation (locked FOR UPDATE when `lock` is set, which needs a transaction and follows the users in the
 * lock order), the actor's membership and, when named, the target's. No policy is applied yet: callers that must tell
 * "already a member" from "not allowed" look at the rows first and then call `enforce`.
 */
export async function loadAccess(
  db: DbOrTx,
  actorId: string,
  conversationId: string,
  options: { lock?: boolean; targetUserId?: string } = {},
): Promise<ConversationAccess & { targetNamed: boolean }> {
  const select = db.select().from(conversations).where(eq(conversations.id, conversationId))
  const rows = options.lock ? await select.for('update') : await select.limit(1)
  const conversation = rows[0]
  if (!conversation) throw new AppError('NOT_FOUND', 'Conversation not found')

  const member = await findMember(db, conversationId, actorId)
  const targetId = options.targetUserId
  const target =
    targetId === undefined
      ? null
      : targetId === actorId
        ? member
        : await findMember(db, conversationId, targetId)
  return { conversation, member, target, targetNamed: targetId !== undefined }
}

/** Applies the policy to rows from `loadAccess`; throws the API error for a refusal. */
export function enforce(
  access: ConversationAccess & { targetNamed: boolean },
  actor: { userId: string; siteRole: SiteRole },
  action: ConversationAction,
  now: Date,
): void {
  const decision = decide(action, {
    conversation: conversationFacts(access.conversation),
    actor: actorFacts(actor, access.member, now),
    target: access.targetNamed ? (access.target ? { role: access.target.role } : null) : undefined,
  })
  if (!decision.allowed) throw refusal(decision)
}

/** `loadAccess` followed by `enforce`: the rows if the action is allowed, the API error if not. */
export async function requireAccess(
  db: DbOrTx,
  actor: { userId: string; siteRole: SiteRole },
  conversationId: string,
  action: ConversationAction,
  options: { lock?: boolean; targetUserId?: string; now: Date },
): Promise<ConversationAccess> {
  const access = await loadAccess(db, actor.userId, conversationId, options)
  enforce(access, actor, action, options.now)
  return access
}
