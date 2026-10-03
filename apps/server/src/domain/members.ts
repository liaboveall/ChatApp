/**
 * Members of channels and groups (docs/05 section 3.3, docs/01 section 5): the list, adding people, removing,
 * banning and unbanning, roles and silences. The permission matrix lives in `authorize.ts`; here each operation takes
 * the locks (the people it changes, then the conversation), applies it, and writes everything the change implies in
 * one transaction: viewer versions, logs, hints, system messages, revoked invitation links and the audit row.
 */
import {
  type AddMembersRequest,
  type AddMembersResponse,
  AppError,
  type Ban,
  type BanRequest,
  type BansResponse,
  LIMITS,
  type Member,
  type MembersPage,
  type PatchMemberRequest,
} from '@chatapp/contracts'
import { conversationBans, conversationMembers, conversations, users } from '@chatapp/db'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { writeAudit } from './audit.ts'
import { enforce, loadAccess, requireAccess } from './authorize.ts'
import { bumpConversation, recordViewerChange } from './changes.ts'
import { cursorExpiry, decodeCursor, encodeCursor } from './cursor.ts'
import type { Deps } from './deps.ts'
import {
  addMembers,
  countLiveMemberships,
  memberLimitOf,
  removeMember,
  revokeInvitesOf,
} from './membership.ts'
import type { SessionPrincipal } from './principal.ts'
import { accountAllowsSession, lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'
import { loadUserSummaries, toUserSummary } from './users.ts'

const DAY_MS = 86_400_000

const staleMembers = (membershipVersion: number) =>
  new AppError('VERSION_CONFLICT', 'The member list changed; reload and try again', {
    details: { membershipVersion },
  })

function checkMembershipVersion(expected: number | undefined, current: number): void {
  if (expected !== undefined && expected !== current) throw staleMembers(current)
}

/** Owner first, then administrators, then members; inside a role in the order they joined. */
const roleRank = sql<number>`case ${conversationMembers.role} when 'owner' then 0 when 'admin' then 1 else 2 end`

export async function listMembers(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  query: { cursor?: string; limit?: number },
): Promise<MembersPage> {
  const limit = query.limit ?? LIMITS.membersPageDefault
  return await deps.db.transaction(
    async (tx) => {
      const now = deps.clock.now()
      const access = await requireAccess(
        tx,
        { userId: principal.userId, siteRole: principal.role },
        conversationId,
        'view_members',
        { now },
      )
      const membershipVersion = access.conversation.membershipVersion

      let after: [number, string, string] | null = null
      if (query.cursor !== undefined) {
        const cursor = decodeCursor(deps, query.cursor, 'mem', principal)
        if (cursor === null || cursor.c !== conversationId) {
          throw new AppError('VALIDATION_FAILED', 'The cursor is not valid for this list', {
            details: { field: 'cursor', reason: 'stale' },
          })
        }
        // The pages of one listing share one membership version; if it moved, the client starts again.
        if (cursor.v !== membershipVersion) throw staleMembers(membershipVersion)
        after = cursor.o
      }

      const rows = await tx
        .select({ member: conversationMembers, rank: roleRank, user: users })
        .from(conversationMembers)
        .innerJoin(users, eq(users.id, conversationMembers.userId))
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            after
              ? sql`(${roleRank}, ${conversationMembers.joinedAt}, ${conversationMembers.userId}) > (${after[0]}, ${after[1]}::timestamptz, ${after[2]}::uuid)`
              : undefined,
          ),
        )
        .orderBy(asc(roleRank), asc(conversationMembers.joinedAt), asc(conversationMembers.userId))
        .limit(limit + 1)

      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      const members: Member[] = page.map((row) => ({
        user: toUserSummary(row.user),
        membershipVersion,
        role: row.member.role,
        membershipId: row.member.membershipId,
        joinedAt: row.member.joinedAt.toISOString(),
        silencedUntil:
          row.member.silencedUntil !== null && row.member.silencedUntil > now
            ? row.member.silencedUntil.toISOString()
            : null,
      }))
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor(deps, {
              k: 'mem',
              u: principal.userId,
              c: conversationId,
              v: membershipVersion,
              o: [last.rank, last.member.joinedAt.toISOString(), last.member.userId],
              x: cursorExpiry(deps),
            })
          : null
      return { members, membershipVersion, nextCursor }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

/**
 * Adds people (docs/05: banned people are skipped and the answer says so). Everyone joins as of this moment and sees
 * only what comes after (D-035).
 */
export async function addConversationMembers(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  input: AddMembersRequest,
): Promise<AddMembersResponse> {
  const wanted = [...new Set(input.userIds)].sort()
  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal, { alsoLock: wanted })
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await requireAccess(tx, actor, conversationId, 'add_members', {
      lock: true,
      now,
    })
    const conversation = access.conversation
    checkMembershipVersion(input.expectedMembershipVersion, conversation.membershipVersion)

    const [people, memberRows, banRows] = await Promise.all([
      tx.select().from(users).where(inArray(users.id, wanted)),
      tx
        .select({ userId: conversationMembers.userId })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            inArray(conversationMembers.userId, wanted),
          ),
        ),
      tx
        .select({ userId: conversationBans.userId })
        .from(conversationBans)
        .where(
          and(
            eq(conversationBans.conversationId, conversationId),
            inArray(conversationBans.userId, wanted),
          ),
        ),
    ])
    const known = new Map(people.map((row) => [row.id, row]))
    const inside = new Set(memberRows.map((row) => row.userId))
    const banned = new Set(banRows.map((row) => row.userId))
    const counts = await countLiveMemberships(tx, wanted)

    const skipped: AddMembersResponse['skipped'] = []
    const toAdd: string[] = []
    let room = memberLimitOf(conversation.kind) - conversation.memberCount
    for (const id of wanted) {
      const candidate = known.get(id)
      if (!candidate || !accountAllowsSession(candidate, now)) {
        skipped.push({ userId: id, reason: 'unavailable' })
      } else if (inside.has(id)) {
        skipped.push({ userId: id, reason: 'already_member' })
      } else if (banned.has(id)) {
        skipped.push({ userId: id, reason: 'banned' })
      } else if (room <= 0 || (counts.get(id) ?? 0) >= LIMITS.maxConversationsPerUser) {
        skipped.push({ userId: id, reason: 'limit_reached' })
      } else {
        toAdd.push(id)
        room -= 1
      }
    }
    await addMembers(
      tx,
      deps,
      conversation,
      toAdd.map((userId) => ({ userId, addedBy: principal.userId })),
    )
    const [versions] = await tx
      .select({ membershipVersion: conversations.membershipVersion })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
    const added = await loadUserSummaries(tx, toAdd)
    return {
      added: toAdd.flatMap((id) => {
        const summary = added.get(id)
        return summary ? [summary] : []
      }),
      skipped,
      membershipVersion: versions?.membershipVersion ?? conversation.membershipVersion,
    }
  })
}

/** Removes a member without banning: they can come back where joining is allowed. */
export async function removeConversationMember(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  targetUserId: string,
): Promise<void> {
  if (targetUserId === principal.userId) {
    throw new AppError('VALIDATION_FAILED', 'Use leave to remove yourself', {
      details: { field: 'userId', reason: 'use_leave' },
    })
  }
  await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal, { alsoLock: [targetUserId] })
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await requireAccess(tx, actor, conversationId, 'remove_member', {
      lock: true,
      targetUserId,
      now,
    })
    if (!access.target) throw new AppError('NOT_FOUND', 'Member not found')
    await removeMember(tx, deps, access.conversation, access.target, {
      type: 'removed',
      actorId: principal.userId,
      banned: false,
    })
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'member.remove',
      targetType: 'conversation',
      targetId: conversationId,
      metadata: { user: targetUserId, siteAdmin: access.member === null },
    })
  })
}

/**
 * Removes and bans, or bans somebody who is not (or no longer) in: a ban is refused at every way back in (INV-13),
 * so it is also the way to fill a ban list in advance.
 */
export async function banConversationMember(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  input: BanRequest,
): Promise<Ban> {
  if (input.userId === principal.userId) {
    throw new AppError('VALIDATION_FAILED', 'You cannot ban yourself', {
      details: { field: 'userId', reason: 'self' },
    })
  }
  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal, { alsoLock: [input.userId] })
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await requireAccess(tx, actor, conversationId, 'ban', {
      lock: true,
      targetUserId: input.userId,
      now,
    })
    checkMembershipVersion(input.expectedMembershipVersion, access.conversation.membershipVersion)
    const [person] = await tx.select().from(users).where(eq(users.id, input.userId))
    if (!person) throw new AppError('NOT_FOUND', 'User not found')

    if (access.target) {
      await removeMember(tx, deps, access.conversation, access.target, {
        type: 'removed',
        actorId: principal.userId,
        banned: true,
      })
    }
    await tx
      .insert(conversationBans)
      .values({
        conversationId,
        userId: input.userId,
        bannedBy: principal.userId,
        reason: input.reason ?? null,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [conversationBans.conversationId, conversationBans.userId],
        set: { bannedBy: principal.userId, reason: input.reason ?? null },
      })
    await bumpConversation(tx, deps, conversationId, { membership: true })
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'member.ban',
      targetType: 'conversation',
      targetId: conversationId,
      metadata: {
        user: input.userId,
        wasMember: access.target !== null,
        siteAdmin: access.member === null,
      },
    })
    return {
      user: toUserSummary(person),
      bannedBy: principal.userId,
      reason: input.reason ?? null,
      createdAt: now.toISOString(),
    }
  })
}

export async function unbanConversationMember(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  targetUserId: string,
): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal)
    const actor = { userId: principal.userId, siteRole: user.role }
    await requireAccess(tx, actor, conversationId, 'unban', { lock: true, now })
    const removed = await tx
      .delete(conversationBans)
      .where(
        and(
          eq(conversationBans.conversationId, conversationId),
          eq(conversationBans.userId, targetUserId),
        ),
      )
      .returning({ userId: conversationBans.userId })
    if (removed.length === 0) return
    await bumpConversation(tx, deps, conversationId, { membership: true })
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'member.unban',
      targetType: 'conversation',
      targetId: conversationId,
      metadata: { user: targetUserId },
    })
  })
}

export async function listBans(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
): Promise<BansResponse> {
  const now = deps.clock.now()
  const actor = { userId: principal.userId, siteRole: principal.role }
  // Same people as may lift a ban; for anyone else the answer is the one of any other forbidden action.
  await requireAccess(deps.db, actor, conversationId, 'unban', { now })
  const rows = await deps.db
    .select({ ban: conversationBans, user: users })
    .from(conversationBans)
    .innerJoin(users, eq(users.id, conversationBans.userId))
    .where(eq(conversationBans.conversationId, conversationId))
    .orderBy(asc(conversationBans.createdAt), asc(conversationBans.userId))
    .limit(500)
  return {
    bans: rows.map((row) => ({
      user: toUserSummary(row.user),
      bannedBy: row.ban.bannedBy,
      reason: row.ban.reason,
      createdAt: row.ban.createdAt.toISOString(),
    })),
  }
}

/** Role (owner only) and silence (administrators) of one member. A silence is always a finite end time. */
export async function updateConversationMember(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  targetUserId: string,
  input: PatchMemberRequest,
): Promise<Member> {
  if (targetUserId === principal.userId) {
    throw new AppError('VALIDATION_FAILED', 'You cannot change your own role or silence', {
      details: { field: 'userId', reason: 'self' },
    })
  }
  let silencedUntil: Date | null | undefined
  if (input.silencedUntil !== undefined) {
    silencedUntil = input.silencedUntil === null ? null : new Date(input.silencedUntil)
    const now = deps.clock.now().getTime()
    if (
      silencedUntil !== null &&
      (silencedUntil.getTime() <= now ||
        silencedUntil.getTime() > now + LIMITS.maxMuteDays * DAY_MS)
    ) {
      throw new AppError('VALIDATION_FAILED', 'A silence must end in the future, within a year', {
        details: { field: 'silencedUntil', reason: 'out_of_range' },
      })
    }
  }
  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal, { alsoLock: [targetUserId] })
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await loadAccess(tx, principal.userId, conversationId, {
      lock: true,
      targetUserId,
    })
    // Seeing the member list comes first: only those who can see it may learn whether somebody is on it.
    enforce(access, actor, 'view', now)
    enforce(access, actor, 'view_members', now)
    const conversation = access.conversation
    const target = access.target
    if (!target) throw new AppError('NOT_FOUND', 'Member not found')
    if (input.role !== undefined) enforce(access, actor, 'change_role', now)
    if (input.silencedUntil !== undefined) enforce(access, actor, 'silence', now)
    checkMembershipVersion(input.expectedMembershipVersion, conversation.membershipVersion)

    const set: Partial<typeof conversationMembers.$inferInsert> = {}
    if (input.role !== undefined && input.role !== target.role) set.role = input.role
    if (
      silencedUntil !== undefined &&
      (silencedUntil?.getTime() ?? null) !== (target.silencedUntil?.getTime() ?? null)
    ) {
      set.silencedUntil = silencedUntil
    }
    if (Object.keys(set).length > 0) {
      await tx
        .update(conversationMembers)
        .set(set)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, targetUserId),
          ),
        )
      await bumpConversation(tx, deps, conversationId, { membership: true })
      await recordViewerChange(tx, deps, {
        userId: targetUserId,
        conversationId,
        membershipId: target.membershipId,
        state: target.hiddenAt ? 'hidden' : 'active',
      })
      // Links belong to people who may make them: a demotion under "admins only" takes theirs away (docs/01 section 4.2).
      if (
        set.role === 'member' &&
        (conversation.settings.whoCanInvite ?? 'all_members') === 'admins_only'
      ) {
        await revokeInvitesOf(tx, deps, conversationId, [targetUserId])
      }
      await writeAudit(tx, {
        actorId: principal.userId,
        action: set.role !== undefined ? 'member.role' : 'member.silence',
        targetType: 'conversation',
        targetId: conversationId,
        metadata: {
          user: targetUserId,
          ...(set.role !== undefined ? { role: set.role } : {}),
          ...(set.silencedUntil !== undefined ? { silenced: set.silencedUntil !== null } : {}),
        },
      })
    }

    const [row] = await tx
      .select({
        member: conversationMembers,
        user: users,
        membershipVersion: conversations.membershipVersion,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, targetUserId),
        ),
      )
    if (!row) throw new AppError('NOT_FOUND', 'Member not found')
    return {
      user: toUserSummary(row.user),
      membershipVersion: row.membershipVersion,
      role: row.member.role,
      membershipId: row.member.membershipId,
      joinedAt: row.member.joinedAt.toISOString(),
      silencedUntil:
        row.member.silencedUntil !== null && row.member.silencedUntil > now
          ? row.member.silencedUntil.toISOString()
          : null,
    }
  })
}
