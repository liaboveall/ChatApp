/**
 * The transaction steps shared by everything that adds or removes people (docs/04 "joining a conversation", docs/03
 * section 5.7): creating a conversation, joining a channel, being added, accepting an invitation link, leaving, being
 * removed or banned. The caller has locked the people involved and then the conversation (so `conversation.lastSeq` is
 * exact) and has already decided that the change is allowed.
 */
import type { MemberRole, NotifyLevel } from '@chatapp/contracts'
import { LIMITS } from '@chatapp/contracts'
import { conversationInvites, conversationMembers, conversations, type Tx } from '@chatapp/db'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import type { ConversationRow, MemberRow } from './authorize.ts'
import { bumpConversation, recordViewerChange } from './changes.ts'
import type { Deps } from './deps.ts'
import { appendSystemMessage } from './system-messages.ts'

export const defaultNotifyLevel = (kind: ConversationRow['kind']): NotifyLevel =>
  kind === 'dm' ? 'all' : 'mentions'

export type NewMember = {
  userId: string
  role?: MemberRole
  /** A direct message starts hidden for the person who did not open it; its first message brings it into view. */
  hidden?: boolean
  /** Who brought them in, for the system message; null when they came by themselves. */
  addedBy: string | null
}

/**
 * Inserts the members, gives each a fresh membership id and viewer version, logs the change in each person's own log and
 * writes the "joined" messages. `fromStart`: a conversation being created, whose first members see everything from
 * the beginning; later joiners see only what comes after the moment they join (D-035).
 */
export async function addMembers(
  tx: Tx,
  deps: Pick<Deps, 'clock' | 'newId'>,
  conversation: Pick<ConversationRow, 'id' | 'kind' | 'lastSeq'>,
  entries: readonly NewMember[],
  options: { fromStart?: boolean; exceptRunId?: string } = {},
): Promise<Array<{ userId: string; membershipId: string }>> {
  if (entries.length === 0) return []
  const now = deps.clock.now()
  const boundary = options.fromStart ? 0 : conversation.lastSeq
  const added = entries.map((entry) => ({ ...entry, membershipId: deps.newId() }))

  await tx.insert(conversationMembers).values(
    added.map((entry) => ({
      conversationId: conversation.id,
      userId: entry.userId,
      role: entry.role ?? 'member',
      joinedAt: now,
      membershipId: entry.membershipId,
      visibleFromSeq: boundary,
      lastReadSeq: boundary,
      notifyLevel: defaultNotifyLevel(conversation.kind),
      hiddenAt: entry.hidden ? now : null,
    })),
  )
  await bumpConversation(tx, deps, conversation.id, {
    memberDelta: added.length,
    membership: true,
    exceptRunId: options.exceptRunId,
  })
  for (const entry of added) {
    await recordViewerChange(tx, deps, {
      userId: entry.userId,
      conversationId: conversation.id,
      membershipId: entry.membershipId,
      state: entry.hidden ? 'hidden' : 'active',
      membershipChanged: true,
    })
  }
  if (!options.fromStart) {
    for (const entry of added) {
      await appendSystemMessage(tx, deps, conversation, {
        type: 'member_joined',
        userId: entry.userId,
        addedBy: entry.addedBy,
      })
    }
  }
  return added.map((entry) => ({ userId: entry.userId, membershipId: entry.membershipId }))
}

/** Invitation links stop working when their creator is no longer allowed to have them (docs/01 section 4.2). */
export async function revokeInvitesOf(
  tx: Tx,
  deps: Pick<Deps, 'clock'>,
  conversationId: string,
  creatorIds: readonly string[],
): Promise<void> {
  if (creatorIds.length === 0) return
  await tx
    .update(conversationInvites)
    .set({ revokedAt: deps.clock.now() })
    .where(
      and(
        eq(conversationInvites.conversationId, conversationId),
        inArray(conversationInvites.createdBy, [...creatorIds]),
        isNull(conversationInvites.revokedAt),
      ),
    )
}

/**
 * Ends a membership. The tombstone and its new viewer version are written first, then the row goes (docs/04), the
 * member count and versions move, the person's links are revoked and the "left"/"removed" message is written.
 */
export async function removeMember(
  tx: Tx,
  deps: Pick<Deps, 'clock' | 'newId'>,
  conversation: Pick<ConversationRow, 'id' | 'kind'>,
  member: Pick<MemberRow, 'userId' | 'membershipId'>,
  reason: { type: 'left' } | { type: 'removed'; actorId: string; banned: boolean },
): Promise<void> {
  await recordViewerChange(tx, deps, {
    userId: member.userId,
    conversationId: conversation.id,
    membershipId: member.membershipId,
    state: 'removed',
    membershipChanged: true,
  })
  await tx
    .delete(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversation.id),
        eq(conversationMembers.userId, member.userId),
      ),
    )
  await revokeInvitesOf(tx, deps, conversation.id, [member.userId])
  await bumpConversation(tx, deps, conversation.id, { memberDelta: -1, membership: true })
  await appendSystemMessage(
    tx,
    deps,
    conversation,
    reason.type === 'left'
      ? { type: 'member_left', userId: member.userId }
      : {
          type: 'member_removed',
          userId: member.userId,
          actorId: reason.actorId,
          banned: reason.banned,
        },
  )
}

/**
 * How many live channels and groups each person is in (direct messages and archived conversations do not count): the
 * limit that keeps one account from collecting thousands of memberships (docs/01 section 7).
 */
export async function countLiveMemberships(
  tx: Tx,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (userIds.length === 0) return counts
  const rows = await tx
    .select({ userId: conversationMembers.userId, n: sql<number>`count(*)::int` })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        inArray(conversationMembers.userId, [...userIds]),
        ne(conversations.kind, 'dm'),
        isNull(conversations.archivedAt),
      ),
    )
    .groupBy(conversationMembers.userId)
  for (const row of rows) counts.set(row.userId, row.n)
  return counts
}

export const memberLimitOf = (kind: ConversationRow['kind']): number =>
  kind === 'channel' ? LIMITS.channelMemberLimit : LIMITS.groupMemberLimit
