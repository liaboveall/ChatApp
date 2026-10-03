/**
 * The read side of conversations: one query per listing that brings, for one viewer, the conversation, their own
 * membership and viewer version, the latest message *they* may see and the other person of a direct message
 * (docs/03 section 10: no N+1). Previews and unread counts are always the viewer's own (docs/05 section 2).
 */
import {
  type Conversation,
  type ConversationMe,
  type ConversationSettings,
  LIMITS,
  type Mute,
} from '@chatapp/contracts'
import {
  conversationBans,
  conversationMembers,
  conversations,
  type DbOrTx,
  messageHidden,
  messages,
  userConversationStates,
  users,
} from '@chatapp/db'
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  type SQL,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { toUserSummary } from './users.ts'

export function viewsQuery(db: DbOrTx, viewerId: string) {
  const peerMember = alias(conversationMembers, 'peer_member')

  const lastMessage = db
    .select({
      id: messages.id,
      senderId: messages.senderId,
      kind: messages.kind,
      excerpt: sql<string | null>`left(${messages.body}, ${LIMITS.excerptMaxCodePoints})`.as(
        'excerpt',
      ),
      recalledAt: messages.recalledAt,
      deletedAt: messages.deletedAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversations.id),
        // Only what the viewer may see: after the boundary, and not "deleted for me".
        gt(messages.seq, conversationMembers.visibleFromSeq),
        notExists(
          db
            .select({ one: sql`1` })
            .from(messageHidden)
            .where(
              and(eq(messageHidden.userId, viewerId), eq(messageHidden.messageId, messages.id)),
            ),
        ),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(1)
    .as('last_message')

  const peer = db
    .select({
      id: users.id,
      profileVersion: users.profileVersion,
      username: users.username,
      name: users.name,
      isBot: users.isBot,
      deletedAt: users.deletedAt,
    })
    .from(peerMember)
    .innerJoin(users, eq(users.id, peerMember.userId))
    .where(
      and(
        eq(conversations.kind, 'dm'),
        eq(peerMember.conversationId, conversations.id),
        ne(peerMember.userId, viewerId),
      ),
    )
    .limit(1)
    .as('peer')

  return db
    .select({
      conversation: conversations,
      member: conversationMembers,
      viewerVersion: userConversationStates.viewerVersion,
      lastMessageId: lastMessage.id,
      lastMessageSenderId: lastMessage.senderId,
      lastMessageKind: lastMessage.kind,
      lastMessageExcerpt: lastMessage.excerpt,
      lastMessageRecalledAt: lastMessage.recalledAt,
      lastMessageDeletedAt: lastMessage.deletedAt,
      peerId: peer.id,
      peerProfileVersion: peer.profileVersion,
      peerUsername: peer.username,
      peerName: peer.name,
      peerIsBot: peer.isBot,
      peerDeletedAt: peer.deletedAt,
    })
    .from(conversations)
    .leftJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, conversations.id),
        eq(conversationMembers.userId, viewerId),
      ),
    )
    .leftJoin(
      userConversationStates,
      and(
        eq(userConversationStates.conversationId, conversations.id),
        eq(userConversationStates.userId, viewerId),
      ),
    )
    .leftJoinLateral(lastMessage, sql`true`)
    .leftJoinLateral(peer, sql`true`)
}

export type ViewRow = Awaited<ReturnType<typeof viewsQuery>>[number]

function muteOf(member: NonNullable<ViewRow['member']>, now: Date): Mute {
  if (member.muteMode === 'forever') return { mode: 'forever' }
  // A limited mute that has run out is just "off" for the reader; the stored row is left for the next change.
  if (member.muteMode === 'until' && member.mutedUntil && member.mutedUntil > now) {
    return { mode: 'until', until: member.mutedUntil.toISOString() }
  }
  return { mode: 'off' }
}

/** Defaults are applied here so older rows and the API agree on what an unset setting means. */
export function normalizeSettings(
  kind: Conversation['kind'],
  stored: ConversationSettings,
): ConversationSettings {
  if (kind === 'dm') return {}
  return {
    whoCanInvite: stored.whoCanInvite ?? 'all_members',
    agentEnabled: stored.agentEnabled ?? true,
  }
}

export function toConversationDto(row: ViewRow, now: Date): Conversation {
  const c = row.conversation
  const m = row.member
  const viewerVersion = m ? (row.viewerVersion ?? m.stateVersion) : 0

  const me: ConversationMe | null = m
    ? {
        version: viewerVersion,
        role: m.role,
        membershipId: m.membershipId,
        visibleFromSeq: m.visibleFromSeq,
        lastReadSeq: m.lastReadSeq,
        unread: Math.max(c.lastSeq - m.lastReadSeq, 0),
        notifyLevel: m.notifyLevel,
        mute: muteOf(m, now),
        silencedUntil:
          m.silencedUntil !== null && m.silencedUntil > now ? m.silencedUntil.toISOString() : null,
        pinnedAt: m.pinnedAt?.toISOString() ?? null,
        hiddenAt: m.hiddenAt?.toISOString() ?? null,
      }
    : null

  const preview =
    row.lastMessageId !== null && row.lastMessageKind !== null
      ? (() => {
          const state = row.lastMessageDeletedAt
            ? ('deleted' as const)
            : row.lastMessageRecalledAt
              ? ('recalled' as const)
              : ('ok' as const)
          return {
            senderId: row.lastMessageSenderId,
            text: state === 'ok' ? row.lastMessageExcerpt : null,
            kind: row.lastMessageKind,
            state,
          }
        })()
      : null

  const dmPeer =
    row.peerId !== null &&
    row.peerProfileVersion !== null &&
    row.peerUsername !== null &&
    row.peerName !== null &&
    row.peerIsBot !== null
      ? toUserSummary({
          id: row.peerId,
          profileVersion: row.peerProfileVersion,
          username: row.peerUsername,
          name: row.peerName,
          isBot: row.peerIsBot,
          deletedAt: row.peerDeletedAt,
        })
      : null

  return {
    id: c.id,
    kind: c.kind,
    name: c.name,
    description: c.description,
    avatarUrl: null,
    metadataVersion: c.metadataVersion,
    membershipVersion: c.membershipVersion,
    viewerVersion,
    memberCount: c.memberCount,
    lastSeq: c.lastSeq,
    lastChangeSeq: c.lastChangeSeq,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: preview,
    dmPeer,
    settings: normalizeSettings(c.kind, c.settings),
    panelForConversationId: c.panelForConversationId,
    archivedAt: c.archivedAt?.toISOString() ?? null,
    previewVersion: { lastChangeSeq: c.lastChangeSeq, viewerVersion },
    me,
  }
}

export async function loadConversation(
  db: DbOrTx,
  viewerId: string,
  conversationId: string,
  now: Date,
): Promise<Conversation | null> {
  const [row] = await viewsQuery(db, viewerId).where(eq(conversations.id, conversationId)).limit(1)
  return row ? toConversationDto(row, now) : null
}

/** Several conversations at once, for the sync feeds: one query, however many entries a page of the log names. */
export async function loadConversationsByIds(
  db: DbOrTx,
  viewerId: string,
  ids: readonly string[],
  now: Date,
): Promise<Map<string, Conversation>> {
  if (ids.length === 0) return new Map()
  const rows = await viewsQuery(db, viewerId).where(inArray(conversations.id, [...ids]))
  return new Map(rows.map((row) => [row.conversation.id, toConversationDto(row, now)]))
}

/** The viewer's live conversations (archived ones leave the list; hidden direct messages stay, flagged by `me.hiddenAt`). */
export async function loadLiveConversations(
  db: DbOrTx,
  viewerId: string,
  now: Date,
): Promise<Conversation[]> {
  const rows = await viewsQuery(db, viewerId)
    .where(and(isNotNull(conversationMembers.userId), isNull(conversations.archivedAt)))
    .orderBy(
      sql`${conversationMembers.pinnedAt} desc nulls last`,
      sql`${conversations.lastMessageAt} desc nulls last`,
      desc(conversations.createdAt),
    )
  return rows.map((row) => toConversationDto(row, now))
}

/** Archived conversations the viewer owns, to restore them (docs/05 section 3.3). */
export async function loadOwnedArchived(
  db: DbOrTx,
  viewerId: string,
  now: Date,
): Promise<Conversation[]> {
  const rows = await viewsQuery(db, viewerId)
    .where(and(eq(conversations.ownerId, viewerId), isNotNull(conversations.archivedAt)))
    .orderBy(desc(conversations.archivedAt), desc(conversations.createdAt))
  return rows.map((row) => toConversationDto(row, now))
}

/**
 * Live channels for the discovery page: alphabetical by normalized name, stable under paging. Channels the viewer is
 * banned from are left out (docs/01 section 4.4: a ban removes discovery as a way back in).
 */
export async function loadChannelsPage(
  db: DbOrTx,
  viewerId: string,
  now: Date,
  params: { needle: string | null; after: [string, string] | null; limit: number },
): Promise<Array<{ dto: Conversation; sortKey: string }>> {
  const sortKey = sql<string>`lower(normalize(${conversations.name}, NFKC))`
  const conditions: SQL[] = [
    eq(conversations.kind, 'channel'),
    isNull(conversations.archivedAt),
    notExists(
      db
        .select({ one: sql`1` })
        .from(conversationBans)
        .where(
          and(
            eq(conversationBans.conversationId, conversations.id),
            eq(conversationBans.userId, viewerId),
          ),
        ),
    ),
  ]
  if (params.needle !== null) {
    const pattern = `%${params.needle.replace(/[\\%_]/g, '\\$&')}%`
    conditions.push(sql`${sortKey} like ${pattern} escape '\\'`)
  }
  if (params.after !== null) {
    conditions.push(
      sql`(${sortKey}, ${conversations.id}) > (${params.after[0]}, ${params.after[1]}::uuid)`,
    )
  }
  const rows = await viewsQuery(db, viewerId)
    .where(and(...conditions))
    .orderBy(sortKey, conversations.id)
    .limit(params.limit)
  if (rows.length === 0) return []
  // The paging key is whatever the database computed for each row, not a JavaScript approximation of it.
  const keys = await db
    .select({ id: conversations.id, key: sortKey })
    .from(conversations)
    .where(
      inArray(
        conversations.id,
        rows.map((row) => row.conversation.id),
      ),
    )
  const keyOf = new Map(keys.map((row) => [row.id, row.key]))
  return rows.map((row) => ({
    dto: toConversationDto(row, now),
    sortKey: keyOf.get(row.conversation.id) ?? '',
  }))
}
