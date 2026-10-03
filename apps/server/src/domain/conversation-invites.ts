/**
 * Invitation links of groups (docs/01 section 4.2, docs/05 section 3.3): `/join#<code>`, valid for registered members
 * only, 7 days and unlimited uses by default. Only the hash of the code is stored and the plaintext is shown once, at
 * creation. A link stops working when its creator may no longer make links (they left, were removed, were demoted
 * under "admins only", or the group went "admins only"); the transactions that cause that revoke them (membership.ts,
 * members.ts, conversations.ts) and acceptance checks it once more.
 */
import {
  AppError,
  type Conversation,
  type ConversationInvite,
  type ConversationInvitePreview,
  type CreateConversationInviteRequest,
  type CreatedConversationInvite,
  formatInviteCode,
  LIMITS,
  normalizeInviteCode,
} from '@chatapp/contracts'
import {
  conversationBans,
  conversationInvites,
  conversationMembers,
  conversations,
} from '@chatapp/db'
import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm'
import { randomBase32, sha256Hex } from '../lib/crypto.ts'
import { isUniqueViolation } from '../lib/pg-error.ts'
import { writeAudit } from './audit.ts'
import { enforce, loadAccess, requireAccess } from './authorize.ts'
import { loadConversation } from './conversation-views.ts'
import type { Deps } from './deps.ts'
import { addMembers, countLiveMemberships, memberLimitOf } from './membership.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'

const DAY_MS = 86_400_000

export const hashConversationInviteCode = (normalizedCode: string): string =>
  sha256Hex(`conversation-invite:${normalizedCode}`)

const invalid = () =>
  new AppError('INVITE_INVALID', 'Invitation link is invalid, expired, used up or revoked')

function toDto(row: typeof conversationInvites.$inferSelect): ConversationInvite {
  return {
    id: row.id,
    conversationId: row.conversationId,
    createdBy: row.createdBy,
    maxUses: row.maxUses,
    useCount: row.useCount,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function createConversationInvite(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  input: CreateConversationInviteRequest,
): Promise<CreatedConversationInvite> {
  const ttlDays = input.expiresInDays ?? LIMITS.conversationInviteDefaultTtlDays
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = randomBase32(10)
    try {
      return await inTransaction(deps.db, async (tx) => {
        const now = deps.clock.now()
        const user = await lockAndRevalidate(tx, deps, principal)
        const actor = { userId: principal.userId, siteRole: user.role }
        const access = await requireAccess(tx, actor, conversationId, 'create_invite', {
          lock: true,
          now,
        })
        const isAdmin = access.member?.role === 'owner' || access.member?.role === 'admin'
        if (!isAdmin) {
          const [live] = await tx
            .select({ n: count() })
            .from(conversationInvites)
            .where(
              and(
                eq(conversationInvites.conversationId, conversationId),
                eq(conversationInvites.createdBy, principal.userId),
                isNull(conversationInvites.revokedAt),
                gt(conversationInvites.expiresAt, now),
              ),
            )
          if ((live?.n ?? 0) >= LIMITS.maxLiveConversationInvitesPerMember) {
            throw new AppError(
              'QUOTA_EXCEEDED',
              'Too many live invitation links; revoke some first',
              {
                details: { resource: 'conversation_invites' },
              },
            )
          }
        }
        const [row] = await tx
          .insert(conversationInvites)
          .values({
            conversationId,
            codeHash: hashConversationInviteCode(code),
            createdBy: principal.userId,
            maxUses: input.maxUses ?? null,
            expiresAt: new Date(now.getTime() + ttlDays * DAY_MS),
            createdAt: now,
          })
          .returning()
        if (!row) throw new Error('invitation link was not created')
        await writeAudit(tx, {
          actorId: principal.userId,
          action: 'conversation_invite.create',
          targetType: 'conversation',
          targetId: conversationId,
        })
        return { ...toDto(row), code: formatInviteCode(code) }
      })
    } catch (error) {
      // An 80-bit collision will not happen; retrying keeps the contract honest anyway.
      if (isUniqueViolation(error, 'conversation_invites_code_hash_unique')) continue
      throw error
    }
  }
  throw new Error('could not generate a unique invitation code')
}

/** Administrators see every link of the group; a member sees the ones they made. */
export async function listConversationInvites(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
): Promise<ConversationInvite[]> {
  const now = deps.clock.now()
  const actor = { userId: principal.userId, siteRole: principal.role }
  const access = await requireAccess(deps.db, actor, conversationId, 'view_members', { now })
  if (access.conversation.kind !== 'group') return []
  const sees =
    access.member?.role === 'owner' || access.member?.role === 'admin' || actor.siteRole === 'admin'
  const rows = await deps.db
    .select()
    .from(conversationInvites)
    .where(
      and(
        eq(conversationInvites.conversationId, conversationId),
        sees ? undefined : eq(conversationInvites.createdBy, principal.userId),
      ),
    )
    .orderBy(desc(conversationInvites.createdAt))
    .limit(100)
  return rows.map(toDto)
}

export async function revokeConversationInvite(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  inviteId: string,
): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal)
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await loadAccess(tx, principal.userId, conversationId, { lock: true })
    enforce(access, actor, 'view', now)
    const [invite] = await tx
      .select()
      .from(conversationInvites)
      .where(
        and(
          eq(conversationInvites.id, inviteId),
          eq(conversationInvites.conversationId, conversationId),
        ),
      )
      .for('update')
    // Somebody who may not even see this link is told it does not exist.
    const mine = invite?.createdBy === principal.userId && access.member !== null
    if (!invite || (!mine && !isModerator(access.member?.role, actor.siteRole))) {
      throw new AppError('NOT_FOUND', 'Invitation link not found')
    }
    if (invite.revokedAt !== null) return
    await tx
      .update(conversationInvites)
      .set({ revokedAt: now })
      .where(eq(conversationInvites.id, inviteId))
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'conversation_invite.revoke',
      targetType: 'conversation',
      targetId: conversationId,
    })
  })
}

const isModerator = (
  role: 'owner' | 'admin' | 'member' | undefined,
  siteRole: 'user' | 'admin',
): boolean => role === 'owner' || role === 'admin' || siteRole === 'admin'

/** What the link leads to, for the confirmation screen. Any problem with the code looks the same (docs/05). */
export async function previewConversationInvite(
  deps: Deps,
  principal: SessionPrincipal,
  rawCode: string,
): Promise<ConversationInvitePreview> {
  const code = normalizeInviteCode(rawCode)
  if (code === null) throw invalid()
  const now = deps.clock.now()
  const [row] = await deps.db
    .select({ invite: conversationInvites, conversation: conversations })
    .from(conversationInvites)
    .innerJoin(conversations, eq(conversations.id, conversationInvites.conversationId))
    .where(eq(conversationInvites.codeHash, hashConversationInviteCode(code)))
    .limit(1)
  if (!row || !inviteIsLive(row.invite, row.conversation, now)) throw invalid()
  const [member] = await deps.db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, row.conversation.id),
        eq(conversationMembers.userId, principal.userId),
      ),
    )
  return {
    name: row.conversation.name ?? '',
    description: row.conversation.description,
    memberCount: row.conversation.memberCount,
    alreadyMember: member !== undefined,
  }
}

function inviteIsLive(
  invite: typeof conversationInvites.$inferSelect,
  conversation: typeof conversations.$inferSelect,
  now: Date,
): boolean {
  return (
    invite.revokedAt === null &&
    invite.expiresAt > now &&
    (invite.maxUses === null || invite.useCount < invite.maxUses) &&
    conversation.kind === 'group' &&
    conversation.archivedAt === null
  )
}

/** Joins the group the link belongs to. Following it again, as a member, changes nothing and uses no further slot. */
export async function acceptConversationInvite(
  deps: Deps,
  principal: SessionPrincipal,
  rawCode: string,
): Promise<Conversation> {
  const code = normalizeInviteCode(rawCode)
  if (code === null) throw invalid()
  const codeHash = hashConversationInviteCode(code)
  // Which conversation to lock is read first; the invite is re-read under the locks below.
  const [peek] = await deps.db
    .select({ conversationId: conversationInvites.conversationId })
    .from(conversationInvites)
    .where(eq(conversationInvites.codeHash, codeHash))
    .limit(1)
  if (!peek) throw invalid()

  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    await lockAndRevalidate(tx, deps, principal)
    const [locked] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, peek.conversationId))
      .for('update')
    if (!locked) throw invalid()
    const [invite] = await tx
      .select()
      .from(conversationInvites)
      .where(eq(conversationInvites.codeHash, codeHash))
      .for('update')
    if (!invite || invite.conversationId !== locked.id || !inviteIsLive(invite, locked, now))
      throw invalid()

    const access = await loadAccess(tx, principal.userId, locked.id)
    if (access.member) {
      const dto = await loadConversation(tx, principal.userId, locked.id, now)
      if (!dto) throw invalid()
      return dto
    }

    const [ban] = await tx
      .select({ userId: conversationBans.userId })
      .from(conversationBans)
      .where(
        and(
          eq(conversationBans.conversationId, locked.id),
          eq(conversationBans.userId, principal.userId),
        ),
      )
    if (ban) throw new AppError('CONVERSATION_BANNED', 'You are banned from this conversation')

    // The creator must still be allowed to make links.
    const creator = await loadAccess(tx, invite.createdBy, locked.id)
    const creatorRole = creator.member?.role
    const creatorMayInvite =
      creatorRole === 'owner' ||
      creatorRole === 'admin' ||
      (creatorRole === 'member' &&
        (locked.settings.whoCanInvite ?? 'all_members') === 'all_members')
    if (!creatorMayInvite) throw invalid()

    if (locked.memberCount >= memberLimitOf(locked.kind)) {
      throw new AppError('QUOTA_EXCEEDED', 'This conversation is full', {
        details: { resource: 'members', limit: memberLimitOf(locked.kind) },
      })
    }
    const counts = await countLiveMemberships(tx, [principal.userId])
    if ((counts.get(principal.userId) ?? 0) >= LIMITS.maxConversationsPerUser) {
      throw new AppError('QUOTA_EXCEEDED', 'You are in as many conversations as allowed', {
        details: { resource: 'conversations', limit: LIMITS.maxConversationsPerUser },
      })
    }

    // The conditional update is the guard, the same way as for registration codes.
    const used = await tx
      .update(conversationInvites)
      .set({ useCount: sql`${conversationInvites.useCount} + 1` })
      .where(
        and(
          eq(conversationInvites.id, invite.id),
          isNull(conversationInvites.revokedAt),
          gt(conversationInvites.expiresAt, now),
          sql`(${conversationInvites.maxUses} is null or ${conversationInvites.useCount} < ${conversationInvites.maxUses})`,
        ),
      )
      .returning({ id: conversationInvites.id })
    if (used.length === 0) throw invalid()

    await addMembers(tx, deps, locked, [{ userId: principal.userId, addedBy: invite.createdBy }])
    const dto = await loadConversation(tx, principal.userId, locked.id, now)
    if (!dto) throw invalid()
    return dto
  })
}
