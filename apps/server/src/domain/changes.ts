/**
 * Sequence numbers, sync logs and realtime hints (docs/03 section 5.1-5.2, docs/04 section 2, D-056, D-082, D-125).
 * Every function here takes the transaction of the business change, so the log entry, the new version and the hint
 * commit or roll back together with it. Callers already hold the locks the lock order asks for: the people involved,
 * then the conversation (docs/03 section 5.1); the allocators below rely on that and do not lock by themselves.
 */
import type {
  ConversationChangeKind,
  ConversationState,
  UserChangeEntity,
} from '@chatapp/contracts'
import {
  conversationChanges,
  conversationMembers,
  conversations,
  type DbOrTx,
  userChanges,
  userConversationStates,
  users,
} from '@chatapp/db'
import { and, eq, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { invalidateConversationRuns } from './agent-access.ts'
import type { Deps } from './deps.ts'
import {
  enqueueMessageEmbedding,
  enqueueNewMessageEmbedding,
  type IndexableMessage,
} from './embeddings.ts'
import { enqueueWork } from './work.ts'

/**
 * What the dispatcher publishes after commit. Hints carry identifiers and versions only, never content, and a lost one
 * costs at most the 30-second reconciliation (docs/03 section 6).
 */
export type RealtimeHint =
  | { event: 'message.changed'; conversationId: string; messageId: string; changeSeq: number }
  | { event: 'conversation.changed'; conversationId: string; metadataVersion: number }
  | { event: 'member.changed'; conversationId: string; membershipVersion: number }
  /** `membership`: the person's conversations changed, so their live subscriptions must be recomputed. */
  | {
      event: 'attachment.updated'
      userId: string
      attachmentId: string
      generation: number
      version: number
    }
  | { event: 'user.changed'; userId: string; userChangeSeq: number; membership: boolean }
  | { event: 'notification'; userId: string; notificationId: string; userChangeSeq: number }
  | { event: 'conversation.removed'; userId: string; conversationId: string; userChangeSeq: number }

export async function enqueueHint(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  hint: RealtimeHint,
): Promise<void> {
  switch (hint.event) {
    case 'message.changed':
      await enqueueWork(tx, deps, {
        kind: 'realtime',
        dedupeKey: `mc:${hint.conversationId}:${hint.changeSeq}`,
        entityId: hint.conversationId,
        entityVersion: hint.changeSeq,
        payload: { event: hint.event, messageId: hint.messageId },
      })
      return
    case 'conversation.changed':
      await enqueueWork(tx, deps, {
        kind: 'realtime',
        dedupeKey: `cm:${hint.conversationId}:${hint.metadataVersion}`,
        entityId: hint.conversationId,
        entityVersion: hint.metadataVersion,
        payload: { event: hint.event },
      })
      return
    case 'member.changed':
      await enqueueWork(tx, deps, {
        kind: 'realtime',
        dedupeKey: `mm:${hint.conversationId}:${hint.membershipVersion}`,
        entityId: hint.conversationId,
        entityVersion: hint.membershipVersion,
        payload: { event: hint.event },
      })
      return
    case 'attachment.updated':
      await enqueueWork(tx, deps, {
        kind: 'realtime',
        dedupeKey: `au:${hint.attachmentId}:${hint.version}`,
        entityId: hint.userId,
        entityVersion: hint.version,
        payload: {
          event: hint.event,
          attachmentId: hint.attachmentId,
          generation: hint.generation,
        },
      })
      return
    case 'user.changed':
      await enqueueWork(tx, deps, {
        kind: 'realtime',
        dedupeKey: `uc:${hint.userId}:${hint.userChangeSeq}`,
        entityId: hint.userId,
        entityVersion: hint.userChangeSeq,
        payload: { event: hint.event, membership: hint.membership },
      })
      return
    case 'notification':
      // Shares the personal sequence number, so it shares the key space of the other personal hints.
      await enqueueWork(tx, deps, {
        kind: 'realtime',
        dedupeKey: `uc:${hint.userId}:${hint.userChangeSeq}`,
        entityId: hint.userId,
        entityVersion: hint.userChangeSeq,
        payload: { event: hint.event, notificationId: hint.notificationId },
      })
      return
    case 'conversation.removed':
      await enqueueWork(tx, deps, {
        kind: 'realtime',
        dedupeKey: `uc:${hint.userId}:${hint.userChangeSeq}`,
        entityId: hint.userId,
        entityVersion: hint.userChangeSeq,
        payload: { event: hint.event, conversationId: hint.conversationId },
      })
      return
  }
}

// ───────── a conversation's own counters ─────────

/** A new message takes the next `seq` and the next `change_seq` in one statement (INV-01); also stamps the last-message time. */
export async function allocateMessageSeq(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  conversationId: string,
): Promise<{ seq: number; changeSeq: number }> {
  const now = deps.clock.now()
  const [row] = await tx
    .update(conversations)
    .set({
      lastSeq: sql`${conversations.lastSeq} + 1`,
      lastChangeSeq: sql`${conversations.lastChangeSeq} + 1`,
      lastMessageAt: now,
      updatedAt: now,
    })
    .where(eq(conversations.id, conversationId))
    .returning({ seq: conversations.lastSeq, changeSeq: conversations.lastChangeSeq })
  if (!row) throw new Error('conversation vanished while allocating a sequence number')
  return row
}

/** A change to an existing message takes the next `change_seq` only (INV-02). */
export async function allocateChangeSeq(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  conversationId: string,
): Promise<number> {
  const [row] = await tx
    .update(conversations)
    .set({
      lastChangeSeq: sql`${conversations.lastChangeSeq} + 1`,
      updatedAt: deps.clock.now(),
    })
    .where(eq(conversations.id, conversationId))
    .returning({ changeSeq: conversations.lastChangeSeq })
  if (!row) throw new Error('conversation vanished while allocating a change number')
  return row.changeSeq
}

/** Writes the log entry for a message change and the hint that tells connected clients to read it. */
export async function recordMessageChange(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  change: {
    conversationId: string
    messageId: string
    changeSeq: number
    kind: ConversationChangeKind
    /**
     * The row, when this transaction has just inserted it. Its search-index intent is then worked out from what the
     * caller holds; otherwise the message is read back and the vectors of its older versions are removed first.
     */
    inserted?: IndexableMessage
  },
): Promise<void> {
  await tx.insert(conversationChanges).values({
    conversationId: change.conversationId,
    changeSeq: change.changeSeq,
    messageId: change.messageId,
    kind: change.kind,
    createdAt: deps.clock.now(),
  })
  if (change.inserted) await enqueueNewMessageEmbedding(tx, deps, change.inserted)
  else await enqueueMessageEmbedding(tx, deps, change.messageId)
  await enqueueHint(tx, deps, {
    event: 'message.changed',
    conversationId: change.conversationId,
    messageId: change.messageId,
    changeSeq: change.changeSeq,
  })
}

export type VersionBump = {
  /** Name, description, settings, member count or archive state changed. */
  metadata?: boolean
  /** Members, roles, silences or bans changed. */
  membership?: boolean
  /** Change of the member count; implies a metadata bump, because the count is part of the shared profile. */
  memberDelta?: number
  /**
   * The private assistant run whose approved effect is making this change (M5a, D-197): its own reading is unchanged,
   * so it is not cancelled with the others; the effect re-baselines its source list in the same transaction.
   */
  exceptRunId?: string
}

/** Moves the shared-profile and member-list versions and tells every connected member (no per-person log: D-125). */
export async function bumpConversation(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  conversationId: string,
  bump: VersionBump,
): Promise<{ metadataVersion: number; membershipVersion: number; memberCount: number }> {
  const metadata = bump.metadata === true || (bump.memberDelta ?? 0) !== 0
  const [row] = await tx
    .update(conversations)
    .set({
      ...(metadata ? { metadataVersion: sql`${conversations.metadataVersion} + 1` } : {}),
      ...(bump.membership
        ? { membershipVersion: sql`${conversations.membershipVersion} + 1` }
        : {}),
      ...(bump.memberDelta
        ? { memberCount: sql`${conversations.memberCount} + ${bump.memberDelta}` }
        : {}),
      updatedAt: deps.clock.now(),
    })
    .where(eq(conversations.id, conversationId))
    .returning({
      metadataVersion: conversations.metadataVersion,
      membershipVersion: conversations.membershipVersion,
      memberCount: conversations.memberCount,
    })
  if (!row) throw new Error('conversation vanished while moving its versions')
  if (metadata) {
    await enqueueHint(tx, deps, {
      event: 'conversation.changed',
      conversationId,
      metadataVersion: row.metadataVersion,
    })
  }
  if (bump.membership) {
    await invalidateConversationRuns(tx, deps, conversationId, bump.exceptRunId)
    await enqueueHint(tx, deps, {
      event: 'member.changed',
      conversationId,
      membershipVersion: row.membershipVersion,
    })
  }
  return row
}

// ───────── a person's own counters ─────────

/** The next number of a person's own log. The caller holds that user's row lock (users come first in the lock order). */
export async function allocateUserChange(tx: DbOrTx, userId: string): Promise<number> {
  const [row] = await tx
    .update(users)
    .set({ userChangeSeq: sql`${users.userChangeSeq} + 1` })
    .where(eq(users.id, userId))
    .returning({ seq: users.userChangeSeq })
  if (!row) throw new Error('user vanished while allocating a personal change number')
  return row.seq
}

/** An entry in a person's log that is not about a conversation relation: hidden messages, their own profile. */
export async function recordUserChange(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  change: {
    userId: string
    entityType: Exclude<UserChangeEntity, 'conversation'>
    entityId: string
  },
): Promise<number> {
  const seq = await allocateUserChange(tx, change.userId)
  await tx.insert(userChanges).values({
    userId: change.userId,
    changeSeq: seq,
    entityType: change.entityType,
    entityId: change.entityId,
    operation: 'upsert',
    createdAt: deps.clock.now(),
  })
  await enqueueHint(tx, deps, {
    event: 'user.changed',
    userId: change.userId,
    userChangeSeq: seq,
    membership: false,
  })
  return seq
}

/**
 * A notification of one person was created or its read state changed (M6). Like every personal change it takes the person's
 * next number and lands in their log, so a device that missed the hint reads it from there; the hint is the `notification`
 * event instead of the general `user.changed`, which tells the client which list to look at.
 */
export async function recordNotificationChange(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  change: { userId: string; notificationId: string; silent?: boolean },
): Promise<number> {
  const seq = await allocateUserChange(tx, change.userId)
  await tx.insert(userChanges).values({
    userId: change.userId,
    changeSeq: seq,
    entityType: 'notification',
    entityId: change.notificationId,
    operation: 'upsert',
    createdAt: deps.clock.now(),
  })
  if (change.silent !== true) {
    await enqueueHint(tx, deps, {
      event: 'notification',
      userId: change.userId,
      notificationId: change.notificationId,
      userChangeSeq: seq,
    })
  }
  return seq
}

/**
 * The same for several entries of one person at once ("mark all read"): each still takes its own number of the person's
 * log, in the order given, but the numbers are allocated in one statement and the log entries written in another, and
 * one hint (for the last entry) wakes the other devices. The caller holds the user's row lock.
 */
export async function recordNotificationChanges(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  change: { userId: string; notificationIds: readonly string[] },
): Promise<void> {
  const count = change.notificationIds.length
  const lastId = change.notificationIds[count - 1]
  if (lastId === undefined) return
  const [row] = await tx
    .update(users)
    .set({ userChangeSeq: sql`${users.userChangeSeq} + ${count}` })
    .where(eq(users.id, change.userId))
    .returning({ last: users.userChangeSeq })
  if (!row) throw new Error('user vanished while allocating personal change numbers')
  const first = row.last - count + 1
  const now = deps.clock.now()
  await tx.insert(userChanges).values(
    change.notificationIds.map((notificationId, index) => ({
      userId: change.userId,
      changeSeq: first + index,
      entityType: 'notification' as const,
      entityId: notificationId,
      operation: 'upsert' as const,
      createdAt: now,
    })),
  )
  await enqueueHint(tx, deps, {
    event: 'notification',
    userId: change.userId,
    notificationId: lastId,
    userChangeSeq: row.last,
  })
}

/**
 * A change of one person's relation to one conversation: joining, leaving, role, silence, preferences, read position.
 * Allocates the person's next number, makes it the viewer version of the relation (the same value goes to the
 * member row), appends the log entry and queues the hint. Leaving writes the `removed` tombstone first and the caller
 * deletes the member row afterwards (docs/04 user_conversation_states). Returns the new viewer version.
 *
 * What changed on the member row itself (read position, preferences, hiding) travels as `memberPatch` and is written
 * by the statement that stamps the row with the new version: one write of the row, and the two cannot come apart.
 */
export async function recordViewerChange(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  change: {
    userId: string
    conversationId: string
    membershipId: string
    state: ConversationState
    /** The set of conversations the person is in changed (join or leave): live subscriptions must be recomputed. */
    membershipChanged?: boolean
    /** Columns of the person's member row that change with this; never with `removed`, where the row is going away. */
    memberPatch?: PgUpdateSetSource<typeof conversationMembers>
  },
): Promise<number> {
  if (change.state === 'removed' && change.memberPatch)
    throw new Error('a removed relation has no member row to change')
  const now = deps.clock.now()
  const seq = await allocateUserChange(tx, change.userId)
  await tx
    .insert(userConversationStates)
    .values({
      userId: change.userId,
      conversationId: change.conversationId,
      membershipId: change.membershipId,
      state: change.state,
      viewerVersion: seq,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userConversationStates.userId, userConversationStates.conversationId],
      set: {
        membershipId: change.membershipId,
        state: change.state,
        viewerVersion: seq,
        updatedAt: now,
      },
    })
  if (change.state !== 'removed') {
    await tx
      .update(conversationMembers)
      .set({ ...change.memberPatch, stateVersion: seq })
      .where(
        and(
          eq(conversationMembers.conversationId, change.conversationId),
          eq(conversationMembers.userId, change.userId),
        ),
      )
  }
  const removed = change.state === 'removed'
  await tx.insert(userChanges).values({
    userId: change.userId,
    changeSeq: seq,
    entityType: 'conversation',
    entityId: change.conversationId,
    operation: removed ? 'remove' : 'upsert',
    createdAt: now,
  })
  await enqueueHint(
    tx,
    deps,
    removed
      ? {
          event: 'conversation.removed',
          userId: change.userId,
          conversationId: change.conversationId,
          userChangeSeq: seq,
        }
      : {
          event: 'user.changed',
          userId: change.userId,
          userChangeSeq: seq,
          membership: change.membershipChanged ?? false,
        },
  )
  return seq
}
