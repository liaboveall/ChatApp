/**
 * Conversation lifecycle (docs/01 section 4.4, docs/05 section 3.3, docs/04 section 2): create, open a direct message,
 * list, discover, join, leave, hand over, archive, restore, change settings, and each person's own preferences and read
 * position. Every write follows the lock order of docs/03 section 5.1: the people involved (sorted), then the
 * conversation, then its members; every one re-checks the session and the policy inside the transaction.
 */
import {
  AppError,
  type ChannelsPage,
  type ChannelsQuery,
  type Conversation,
  type ConversationListResponse,
  type CreateConversationRequest,
  LIMITS,
  type Mute,
  type MuteMode,
  type PatchConversationMeRequest,
  type PatchConversationRequest,
  type RestoreConversationRequest,
  type TransferRequest,
} from '@chatapp/contracts'
import {
  conversationBans,
  conversationInvites,
  conversationMembers,
  conversations,
  type DbOrTx,
  dmPairs,
  userConversationStates,
  users,
} from '@chatapp/db'
import { and, eq, inArray, isNull, notExists, sql } from 'drizzle-orm'
import { fingerprint } from '../lib/crypto.ts'
import { isUniqueViolation } from '../lib/pg-error.ts'
import { writeAudit } from './audit.ts'
import { enforce, loadAccess, requireAccess } from './authorize.ts'
import { bumpConversation, recordViewerChange } from './changes.ts'
import {
  loadChannelsPage,
  loadConversation,
  loadLiveConversations,
  loadOwnedArchived,
} from './conversation-views.ts'
import { cursorExpiry, decodeCursor, encodeCursor } from './cursor.ts'
import type { Deps } from './deps.ts'
import { assertIdempotencyKey, claimIdempotency, completeIdempotency } from './idempotency.ts'
import { addMembers, countLiveMemberships, memberLimitOf, removeMember } from './membership.ts'
import type { SessionPrincipal } from './principal.ts'
import { accountAllowsSession, lockAndRevalidate } from './sessions.ts'
import { appendSystemMessage } from './system-messages.ts'
import { inTransaction } from './tx.ts'

const DAY_MS = 86_400_000

const nameTaken = () =>
  new AppError('CONFLICT', 'A live channel already has this name', {
    details: { field: 'name', reason: 'taken' },
  })

/** Channel names are unique among live channels; the index decides, and a violation becomes the 409 clients expect (L-03). */
async function withNameConflict<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isUniqueViolation(error, 'conversations_channel_name_uidx')) throw nameTaken()
    throw error
  }
}

async function viewOrGone(
  tx: DbOrTx,
  viewerId: string,
  conversationId: string,
  now: Date,
): Promise<Conversation> {
  const dto = await loadConversation(tx, viewerId, conversationId, now)
  if (!dto) throw new AppError('NOT_FOUND', 'Conversation not found')
  return dto
}

// ───────── reading ─────────

/**
 * The viewer's conversations with unread counts and previews, from one consistent snapshot: `userChangeSeq` is the
 * baseline a client continues its personal sync from (docs/05 section 4.5).
 */
export async function listConversations(
  deps: Deps,
  principal: SessionPrincipal,
  options: { archived: boolean },
): Promise<ConversationListResponse> {
  return await deps.db.transaction(
    async (tx) => {
      const now = deps.clock.now()
      const [owner] = await tx
        .select({ seq: users.userChangeSeq })
        .from(users)
        .where(eq(users.id, principal.userId))
      const list = options.archived
        ? await loadOwnedArchived(tx, principal.userId, now)
        : await loadLiveConversations(tx, principal.userId, now)
      return { conversations: list, userChangeSeq: owner?.seq ?? 0 }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

export async function getConversation(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
): Promise<Conversation> {
  const now = deps.clock.now()
  await requireAccess(
    deps.db,
    { userId: principal.userId, siteRole: principal.role },
    conversationId,
    'view',
    { now },
  )
  return await viewOrGone(deps.db, principal.userId, conversationId, now)
}

export async function discoverChannels(
  deps: Deps,
  principal: SessionPrincipal,
  query: ChannelsQuery,
): Promise<ChannelsPage> {
  const now = deps.clock.now()
  const limit = query.limit ?? LIMITS.channelsPageDefault
  const needle = query.query ? query.query.normalize('NFKC').toLowerCase().trim() : null
  let after: [string, string] | null = null
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(deps, query.cursor, 'chn', principal)
    // A cursor from another search, or an expired one, is simply a request to start over.
    if (cursor === null || cursor.q !== (needle ?? '')) {
      throw new AppError('VALIDATION_FAILED', 'The cursor is not valid for this search', {
        details: { field: 'cursor', reason: 'stale' },
      })
    }
    after = cursor.o
  }
  // One more than asked for tells whether another page follows.
  const rows = await loadChannelsPage(deps.db, principal.userId, now, {
    needle,
    after,
    limit: limit + 1,
  })
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(deps, {
          k: 'chn',
          u: principal.userId,
          q: needle ?? '',
          o: [last.sortKey, last.dto.id],
          x: cursorExpiry(deps),
        })
      : null
  return { items: page.map((row) => row.dto), nextCursor }
}

// ───────── creating ─────────

/**
 * A new channel or group; the creator becomes its owner and the people named join from the beginning. The
 * `Idempotency-Key` makes a retry return the same conversation instead of a second one (D-066).
 */
export async function createConversation(
  deps: Deps,
  principal: SessionPrincipal,
  input: CreateConversationRequest,
  idempotencyKey: string,
): Promise<{ conversation: Conversation; created: boolean }> {
  assertIdempotencyKey(idempotencyKey)
  const named = [...new Set(input.memberIds ?? [])].filter((id) => id !== principal.userId).sort()
  const requestHash = fingerprint({
    v: 1,
    kind: input.kind,
    name: input.name,
    description: input.description ?? null,
    memberIds: named,
  })

  return await withNameConflict(() =>
    inTransaction(deps.db, async (tx) => {
      const now = deps.clock.now()
      const creator = await lockAndRevalidate(tx, deps, principal, { alsoLock: named })
      const claim = await claimIdempotency(
        tx,
        deps,
        {
          actorKey: principal.userId,
          operation: 'conversation.create',
          targetKey: 'self',
          key: idempotencyKey,
        },
        requestHash,
      )
      if (claim.status === 'replay') {
        if (!claim.resourceId) {
          throw new AppError(
            'RESOURCE_GONE',
            'The conversation this request created no longer exists',
          )
        }
        const [exists] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, claim.resourceId))
        if (!exists) {
          throw new AppError(
            'RESOURCE_GONE',
            'The conversation this request created no longer exists',
          )
        }
        // Re-authorized like any read: someone who left a group since is told it does not exist.
        await requireAccess(
          tx,
          { userId: principal.userId, siteRole: creator.role },
          exists.id,
          'view',
          { now },
        )
        return {
          conversation: await viewOrGone(tx, principal.userId, exists.id, now),
          created: false,
        }
      }

      if (named.length > 0) {
        const people = await tx.select().from(users).where(inArray(users.id, named))
        const usable = new Set(people.filter((u) => accountAllowsSession(u, now)).map((u) => u.id))
        if (named.some((id) => !usable.has(id))) {
          throw new AppError('VALIDATION_FAILED', 'Some of the people named cannot be added', {
            details: { field: 'memberIds', reason: 'unknown_or_unavailable' },
          })
        }
      }
      const counts = await countLiveMemberships(tx, [principal.userId, ...named])
      if ((counts.get(principal.userId) ?? 0) >= LIMITS.maxConversationsPerUser) {
        throw new AppError('QUOTA_EXCEEDED', 'You are in as many conversations as allowed', {
          details: { resource: 'conversations', limit: LIMITS.maxConversationsPerUser },
        })
      }
      // People who are at their own limit are left out rather than failing the whole creation.
      const joiners = named.filter((id) => (counts.get(id) ?? 0) < LIMITS.maxConversationsPerUser)

      const id = deps.newId()
      await tx.insert(conversations).values({
        id,
        kind: input.kind,
        name: input.name,
        description: input.description ?? null,
        ownerId: principal.userId,
        settings: { whoCanInvite: 'all_members', agentEnabled: true },
        createdBy: principal.userId,
        createdAt: now,
        updatedAt: now,
      })
      await addMembers(
        tx,
        deps,
        { id, kind: input.kind, lastSeq: 0 },
        [
          { userId: principal.userId, role: 'owner', addedBy: null },
          ...joiners.map((userId) => ({ userId, addedBy: principal.userId })),
        ],
        { fromStart: true },
      )
      await completeIdempotency(tx, claim.id, { type: 'conversation', id })
      return { conversation: await viewOrGone(tx, principal.userId, id, now), created: true }
    }),
  )
}

/**
 * The direct message with another member: opened if it exists, created if not (one per pair, INV-04). The person who did
 * not open it sees it only when the first message arrives; the opener's own hidden copy comes back into view.
 */
export async function openDirectMessage(
  deps: Deps,
  principal: SessionPrincipal,
  input: { userId: string },
): Promise<{ conversation: Conversation; created: boolean }> {
  if (input.userId === principal.userId) {
    throw new AppError('VALIDATION_FAILED', 'A direct message needs another person', {
      details: { field: 'userId', reason: 'self' },
    })
  }
  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    await lockAndRevalidate(tx, deps, principal, { alsoLock: [input.userId] })
    const [peer] = await tx.select().from(users).where(eq(users.id, input.userId))
    if (!peer || !accountAllowsSession(peer, now)) throw new AppError('NOT_FOUND', 'User not found')

    const [low, high] =
      principal.userId < input.userId
        ? [principal.userId, input.userId]
        : [input.userId, principal.userId]
    const [pair] = await tx
      .select({ conversationId: dmPairs.conversationId })
      .from(dmPairs)
      .where(and(eq(dmPairs.userLow, low), eq(dmPairs.userHigh, high)))
    if (pair) {
      const access = await loadAccess(tx, principal.userId, pair.conversationId, { lock: true })
      if (access.member?.hiddenAt) {
        await tx
          .update(conversationMembers)
          .set({ hiddenAt: null })
          .where(
            and(
              eq(conversationMembers.conversationId, pair.conversationId),
              eq(conversationMembers.userId, principal.userId),
            ),
          )
        await recordViewerChange(tx, deps, {
          userId: principal.userId,
          conversationId: pair.conversationId,
          membershipId: access.member.membershipId,
          state: 'active',
        })
      }
      return {
        conversation: await viewOrGone(tx, principal.userId, pair.conversationId, now),
        created: false,
      }
    }

    const id = deps.newId()
    await tx.insert(conversations).values({
      id,
      kind: 'dm',
      createdBy: principal.userId,
      createdAt: now,
      updatedAt: now,
    })
    await tx.insert(dmPairs).values({ userLow: low, userHigh: high, conversationId: id })
    await addMembers(
      tx,
      deps,
      { id, kind: 'dm', lastSeq: 0 },
      [
        { userId: principal.userId, addedBy: null },
        { userId: input.userId, hidden: true, addedBy: principal.userId },
      ],
      { fromStart: true },
    )
    return { conversation: await viewOrGone(tx, principal.userId, id, now), created: true }
  })
}

// ───────── joining, leaving, handing over ─────────

/** Joins a channel by oneself. Joining twice changes nothing; a banned person is refused (INV-13). */
export async function joinConversation(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
): Promise<Conversation> {
  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal)
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await loadAccess(tx, principal.userId, conversationId, { lock: true })
    enforce(access, actor, 'view', now)
    if (access.member) return await viewOrGone(tx, principal.userId, conversationId, now)
    enforce(access, actor, 'join', now)

    const [ban] = await tx
      .select({ userId: conversationBans.userId })
      .from(conversationBans)
      .where(
        and(
          eq(conversationBans.conversationId, conversationId),
          eq(conversationBans.userId, principal.userId),
        ),
      )
    if (ban) throw new AppError('CONVERSATION_BANNED', 'You are banned from this conversation')

    const conversation = access.conversation
    if (conversation.memberCount >= memberLimitOf(conversation.kind)) {
      throw new AppError('QUOTA_EXCEEDED', 'This conversation is full', {
        details: { resource: 'members', limit: memberLimitOf(conversation.kind) },
      })
    }
    const counts = await countLiveMemberships(tx, [principal.userId])
    if ((counts.get(principal.userId) ?? 0) >= LIMITS.maxConversationsPerUser) {
      throw new AppError('QUOTA_EXCEEDED', 'You are in as many conversations as allowed', {
        details: { resource: 'conversations', limit: LIMITS.maxConversationsPerUser },
      })
    }
    await addMembers(tx, deps, conversation, [{ userId: principal.userId, addedBy: null }])
    return await viewOrGone(tx, principal.userId, conversationId, now)
  })
}

/**
 * Leaves a channel or group. The owner must hand over first, unless nobody else is left: then the conversation is
 * archived in the same transaction and stays the owner's to restore (docs/04). Leaving a conversation one is not in
 * is not an error for a channel (the end state is what was asked for), and a direct message cannot be left at all.
 */
export async function leaveConversation(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal)
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await loadAccess(tx, principal.userId, conversationId, { lock: true })
    enforce(access, actor, 'view', now)
    if (!access.member) {
      if (access.conversation.kind === 'channel') return
      enforce(access, actor, 'leave', now)
      return
    }
    enforce(access, actor, 'leave', now)

    const conversation = access.conversation
    if (access.member.role === 'owner') {
      if (conversation.memberCount > 1) {
        throw new AppError('CONFLICT', 'Hand over the conversation before leaving it', {
          details: { reason: 'owner_must_transfer' },
        })
      }
      // Alone: the conversation is archived with the owner kept as its administrator, and the member list is emptied.
      await tx
        .update(conversations)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(conversations.id, conversationId))
      await bumpConversation(tx, deps, conversationId, { metadata: true })
    }
    await removeMember(tx, deps, conversation, access.member, { type: 'left' })
  })
}

export async function transferOwnership(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  input: TransferRequest,
): Promise<Conversation> {
  if (input.userId === principal.userId) {
    throw new AppError('VALIDATION_FAILED', 'You already own this conversation', {
      details: { field: 'userId', reason: 'self' },
    })
  }
  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal, { alsoLock: [input.userId] })
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await requireAccess(tx, actor, conversationId, 'transfer', {
      lock: true,
      targetUserId: input.userId,
      now,
    })
    const conversation = access.conversation
    if (!access.target) {
      throw new AppError('VALIDATION_FAILED', 'The new owner must be a member', {
        details: { field: 'userId', reason: 'not_a_member' },
      })
    }
    if (
      input.expectedMembershipVersion !== undefined &&
      input.expectedMembershipVersion !== conversation.membershipVersion
    ) {
      throw new AppError('VERSION_CONFLICT', 'The member list changed; reload and try again', {
        details: { membershipVersion: conversation.membershipVersion },
      })
    }
    // Demote first, then promote, then point owner_id at the heir: the deferred check sees the final state (INV-23).
    await tx
      .update(conversationMembers)
      .set({ role: 'admin' })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, principal.userId),
        ),
      )
    await tx
      .update(conversationMembers)
      .set({ role: 'owner' })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, input.userId),
        ),
      )
    await tx
      .update(conversations)
      .set({ ownerId: input.userId })
      .where(eq(conversations.id, conversationId))
    await bumpConversation(tx, deps, conversationId, { membership: true })
    for (const member of [access.member, access.target]) {
      if (!member) continue
      await recordViewerChange(tx, deps, {
        userId: member.userId,
        conversationId,
        membershipId: member.membershipId,
        state: member.hiddenAt ? 'hidden' : 'active',
      })
    }
    await appendSystemMessage(tx, deps, conversation, {
      type: 'owner_transferred',
      actorId: principal.userId,
      userId: input.userId,
    })
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'conversation.transfer',
      targetType: 'conversation',
      targetId: conversationId,
      metadata: { to: input.userId },
    })
    return await viewOrGone(tx, principal.userId, conversationId, now)
  })
}

// ───────── archive and restore ─────────

/**
 * Archiving is shared metadata: the conversation turns read-only and leaves every member's list, derived from
 * `archived_at`, without a write per member (D-125). The channel name is free again at once.
 */
export async function archiveConversation(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
): Promise<Conversation> {
  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal)
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await requireAccess(tx, actor, conversationId, 'archive', { lock: true, now })
    if (access.conversation.archivedAt === null) {
      await tx
        .update(conversations)
        .set({ archivedAt: now })
        .where(eq(conversations.id, conversationId))
      await bumpConversation(tx, deps, conversationId, { metadata: true })
      await writeAudit(tx, {
        actorId: principal.userId,
        action: 'conversation.archive',
        targetType: 'conversation',
        targetId: conversationId,
        metadata: { siteAdmin: access.member?.role !== 'owner' },
      })
    }
    return await viewOrGone(tx, principal.userId, conversationId, now)
  })
}

/**
 * Restores an archived conversation. A channel whose name was taken meanwhile needs a new one (`name`); a conversation
 * whose owner left alone gets that owner back as a new member who sees what comes after the restore; one without any
 * owner needs `ownerUserId` (docs/04). It can never come back without an owner (INV-23).
 */
export async function restoreConversation(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  input: RestoreConversationRequest,
): Promise<Conversation> {
  // Who is locked next depends on the owner: look first (no lock), confirm under the lock.
  const [peek] = await deps.db
    .select({ ownerId: conversations.ownerId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
  const ownerCandidate = peek ? (peek.ownerId ?? input.ownerUserId ?? null) : null

  return await withNameConflict(() =>
    inTransaction(deps.db, async (tx) => {
      const now = deps.clock.now()
      const user = await lockAndRevalidate(tx, deps, principal, {
        alsoLock: ownerCandidate ? [ownerCandidate] : [],
      })
      const actor = { userId: principal.userId, siteRole: user.role }
      const access = await requireAccess(tx, actor, conversationId, 'restore', { lock: true, now })
      const conversation = access.conversation
      if (conversation.archivedAt === null) {
        return await viewOrGone(tx, principal.userId, conversationId, now)
      }

      let ownerId = conversation.ownerId
      if (ownerId === null) {
        if (!input.ownerUserId) {
          throw new AppError('VALIDATION_FAILED', 'This conversation has no owner; name one', {
            details: { field: 'ownerUserId', reason: 'required' },
          })
        }
        const [heir] = await tx.select().from(users).where(eq(users.id, input.ownerUserId))
        if (!heir || !accountAllowsSession(heir, now)) {
          throw new AppError('VALIDATION_FAILED', 'The new owner cannot be used', {
            details: { field: 'ownerUserId', reason: 'unavailable' },
          })
        }
        ownerId = heir.id
      } else if (input.ownerUserId && input.ownerUserId !== ownerId) {
        throw new AppError('VALIDATION_FAILED', 'This conversation already has an owner', {
          details: { field: 'ownerUserId', reason: 'has_owner' },
        })
      }
      if (ownerId !== ownerCandidate) {
        // The owner changed between the look and the lock: nothing was locked for them, so try again from the start.
        throw new AppError(
          'CONFLICT',
          'The conversation changed while it was being restored; try again',
        )
      }

      const [existing] = await tx
        .select()
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, ownerId),
          ),
        )
      await tx
        .update(conversations)
        .set({
          archivedAt: null,
          ownerId,
          ...(input.name !== undefined ? { name: input.name } : {}),
        })
        .where(eq(conversations.id, conversationId))
      if (existing) {
        if (existing.role !== 'owner') {
          await tx
            .update(conversationMembers)
            .set({ role: 'owner' })
            .where(
              and(
                eq(conversationMembers.conversationId, conversationId),
                eq(conversationMembers.userId, ownerId),
              ),
            )
          await recordViewerChange(tx, deps, {
            userId: ownerId,
            conversationId,
            membershipId: existing.membershipId,
            state: existing.hiddenAt ? 'hidden' : 'active',
          })
        }
        await bumpConversation(tx, deps, conversationId, {
          metadata: true,
          membership: existing.role !== 'owner',
        })
      } else {
        await bumpConversation(tx, deps, conversationId, { metadata: true })
        await addMembers(tx, deps, conversation, [
          { userId: ownerId, role: 'owner', addedBy: null },
        ])
      }
      await writeAudit(tx, {
        actorId: principal.userId,
        action: 'conversation.restore',
        targetType: 'conversation',
        targetId: conversationId,
        metadata: { renamed: input.name !== undefined, newOwner: conversation.ownerId === null },
      })
      return await viewOrGone(tx, principal.userId, conversationId, now)
    }),
  )
}

// ───────── shared settings ─────────

export async function updateConversation(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  input: PatchConversationRequest,
): Promise<Conversation> {
  return await withNameConflict(() =>
    inTransaction(deps.db, async (tx) => {
      const now = deps.clock.now()
      const user = await lockAndRevalidate(tx, deps, principal)
      const actor = { userId: principal.userId, siteRole: user.role }
      const access = await requireAccess(tx, actor, conversationId, 'update', { lock: true, now })
      const conversation = access.conversation
      if (input.expectedMetadataVersion !== conversation.metadataVersion) {
        throw new AppError('VERSION_CONFLICT', 'The conversation changed; reload and try again', {
          details: { metadataVersion: conversation.metadataVersion },
        })
      }

      const set: Partial<typeof conversations.$inferInsert> = {}
      const changed: string[] = []
      if (input.name !== undefined && input.name !== conversation.name) {
        set.name = input.name
        changed.push('name')
      }
      if (input.description !== undefined) {
        const next =
          input.description === null || input.description === '' ? null : input.description
        if (next !== conversation.description) {
          set.description = next
          changed.push('description')
        }
      }
      let invitesTightened = false
      if (input.settings !== undefined) {
        const merged = { ...conversation.settings, ...input.settings }
        if (JSON.stringify(merged) !== JSON.stringify(conversation.settings)) {
          set.settings = merged
          changed.push('settings')
          invitesTightened =
            input.settings.whoCanInvite === 'admins_only' &&
            (conversation.settings.whoCanInvite ?? 'all_members') !== 'admins_only'
        }
      }
      if (changed.length === 0) return await viewOrGone(tx, principal.userId, conversationId, now)

      await tx.update(conversations).set(set).where(eq(conversations.id, conversationId))
      await bumpConversation(tx, deps, conversationId, { metadata: true })
      if (set.name !== undefined && conversation.name !== null) {
        await appendSystemMessage(tx, deps, conversation, {
          type: 'conversation_renamed',
          actorId: principal.userId,
          from: conversation.name,
          to: set.name ?? conversation.name,
        })
      }
      if (invitesTightened) {
        // Links made by people who are no longer allowed to make them stop working (docs/01 section 4.2).
        await tx
          .update(conversationInvites)
          .set({ revokedAt: now })
          .where(
            and(
              eq(conversationInvites.conversationId, conversationId),
              isNull(conversationInvites.revokedAt),
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(conversationMembers)
                  .where(
                    and(
                      eq(conversationMembers.conversationId, conversationId),
                      eq(conversationMembers.userId, conversationInvites.createdBy),
                      inArray(conversationMembers.role, ['owner', 'admin']),
                    ),
                  ),
              ),
            ),
          )
      }
      await writeAudit(tx, {
        actorId: principal.userId,
        action: 'conversation.update',
        targetType: 'conversation',
        targetId: conversationId,
        metadata: { fields: changed.join(','), siteAdmin: access.member === null },
      })
      return await viewOrGone(tx, principal.userId, conversationId, now)
    }),
  )
}

// ───────── my own preferences and reading position ─────────

function resolveMute(
  deps: Pick<Deps, 'clock'>,
  mute: Mute,
): { muteMode: MuteMode; mutedUntil: Date | null } {
  if (mute.mode !== 'until') return { muteMode: mute.mode, mutedUntil: null }
  const now = deps.clock.now().getTime()
  const until = new Date(mute.until)
  if (!(until.getTime() > now) || until.getTime() > now + LIMITS.maxMuteDays * DAY_MS) {
    throw new AppError('VALIDATION_FAILED', 'The mute must end in the future, within a year', {
      details: { field: 'mute', reason: 'until_out_of_range' },
    })
  }
  return { muteMode: 'until', mutedUntil: until }
}

/**
 * Notification level, mute, pin and (for direct messages) hide: the viewer's own relation, changed conditionally on the
 * viewer version they last saw (D-082). A request that changes nothing changes no version.
 */
export async function updateMyConversationSettings(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  input: PatchConversationMeRequest,
): Promise<Conversation> {
  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal)
    const actor = { userId: principal.userId, siteRole: user.role }
    // Only the viewer's own row changes and the user lock above already serializes it: no conversation lock is needed.
    const access = await loadAccess(tx, principal.userId, conversationId)
    enforce(access, actor, 'view', now)
    enforce(access, actor, 'set_preferences', now)
    const member = access.member
    if (!member) throw new AppError('NOT_FOUND', 'Conversation not found')

    const [state] = await tx
      .select({ viewerVersion: userConversationStates.viewerVersion })
      .from(userConversationStates)
      .where(
        and(
          eq(userConversationStates.userId, principal.userId),
          eq(userConversationStates.conversationId, conversationId),
        ),
      )
    const current = state?.viewerVersion ?? member.stateVersion
    if (input.expectedViewerVersion !== current) {
      throw new AppError(
        'VERSION_CONFLICT',
        'Your settings for this conversation changed elsewhere',
        {
          details: { viewerVersion: current },
        },
      )
    }
    if (input.hidden !== undefined && access.conversation.kind !== 'dm') {
      throw new AppError('VALIDATION_FAILED', 'Only direct messages can be hidden', {
        details: { field: 'hidden', reason: 'not_a_direct_message' },
      })
    }

    const set: Partial<typeof conversationMembers.$inferInsert> = {}
    if (input.notifyLevel !== undefined && input.notifyLevel !== member.notifyLevel) {
      set.notifyLevel = input.notifyLevel
    }
    if (input.mute !== undefined) {
      const next = resolveMute(deps, input.mute)
      const same =
        next.muteMode === member.muteMode &&
        (next.mutedUntil?.getTime() ?? null) === (member.mutedUntil?.getTime() ?? null)
      if (!same) Object.assign(set, next)
    }
    if (input.pinned !== undefined && input.pinned !== (member.pinnedAt !== null)) {
      set.pinnedAt = input.pinned ? now : null
    }
    if (input.hidden !== undefined && input.hidden !== (member.hiddenAt !== null)) {
      set.hiddenAt = input.hidden ? now : null
    }
    if (Object.keys(set).length === 0)
      return await viewOrGone(tx, principal.userId, conversationId, now)

    await tx
      .update(conversationMembers)
      .set(set)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, principal.userId),
        ),
      )
    const hidden = set.hiddenAt !== undefined ? set.hiddenAt !== null : member.hiddenAt !== null
    await recordViewerChange(tx, deps, {
      userId: principal.userId,
      conversationId,
      membershipId: member.membershipId,
      state: hidden ? 'hidden' : 'active',
    })
    return await viewOrGone(tx, principal.userId, conversationId, now)
  })
}

/**
 * Moves my read position forward to `seq` (never past the last message, never back): the one write that is not
 * conditional on a version, because it only ever increases (docs/05 section 2, INV-08).
 */
export async function markConversationRead(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  seq: number,
): Promise<Conversation> {
  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal)
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await loadAccess(tx, principal.userId, conversationId)
    enforce(access, actor, 'view', now)
    enforce(access, actor, 'read_messages', now)
    const member = access.member
    if (!member) throw new AppError('NOT_FOUND', 'Conversation not found')

    const target = Math.min(seq, access.conversation.lastSeq)
    if (target > member.lastReadSeq) {
      await tx
        .update(conversationMembers)
        .set({ lastReadSeq: sql`greatest(${conversationMembers.lastReadSeq}, ${target})` })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, principal.userId),
          ),
        )
      await recordViewerChange(tx, deps, {
        userId: principal.userId,
        conversationId,
        membershipId: member.membershipId,
        state: member.hiddenAt ? 'hidden' : 'active',
      })
    }
    return await viewOrGone(tx, principal.userId, conversationId, now)
  })
}
