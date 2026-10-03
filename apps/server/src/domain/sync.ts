/**
 * The sync feeds (docs/05 section 4.5, docs/03 section 5.2, D-056, D-126): a conversation's change log, a person's own
 * change log, and the version heads. A feed reads a log with a fixed upper bound (`through`, set by the first page) and
 * answers each entry with the *current authorized* state of the entity it names, so a late reader sees the final state
 * and never anything it may not see. `scannedThrough` is how far the log was read, also when every entry was filtered
 * out; only the last page lets a client move its synced mark to `through`. When the log cannot be replayed (expired, too
 * far behind, cursor from another life) the answer is a reset with a consistent snapshot to rebuild from.
 */
import {
  AppError,
  type ChangesQuery,
  type Conversation,
  type ConversationChangesResponse,
  LIMITS,
  type SyncHeadsResponse,
  type UserChangeItem,
  type UserChangesResponse,
} from '@chatapp/contracts'
import {
  conversationChanges,
  conversationMembers,
  conversations,
  type DbOrTx,
  messageHidden,
  messages,
  userChanges,
  userConversationStates,
  users,
} from '@chatapp/db'
import { and, asc, eq, gt, inArray, lte } from 'drizzle-orm'
import { enforce, loadAccess } from './authorize.ts'
import {
  loadConversation,
  loadConversationsByIds,
  loadLiveConversations,
} from './conversation-views.ts'
import { cursorExpiry, decodeCursor, encodeCursor } from './cursor.ts'
import type { Deps } from './deps.ts'
import { loadMe } from './me.ts'
import { latestMessages, projectMessages, type Viewer } from './messages.ts'
import type { SessionPrincipal } from './principal.ts'

const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const

async function userSeq(db: DbOrTx, userId: string): Promise<{ seq: number; floor: number }> {
  const [row] = await db
    .select({ seq: users.userChangeSeq, floor: users.changeLogFloor })
    .from(users)
    .where(eq(users.id, userId))
  if (!row) throw new AppError('UNAUTHENTICATED', 'Session is no longer valid')
  return row
}

/** Decides where a feed starts: the first page from `after` up to the head, later pages from their cursor. */
type Position = { after: number; through: number; reset: boolean }

function position(
  query: ChangesQuery,
  cursor: { a: number; t: number } | null,
  valid: boolean,
  head: number,
  floor: number,
): Position {
  if (query.cursor !== undefined) {
    if (!valid || cursor === null) return { after: 0, through: head, reset: true }
    // A cursor already passed the size check on its first page; only a purge since then invalidates it.
    return { after: cursor.a, through: cursor.t, reset: cursor.a < floor }
  }
  const after = query.after ?? 0
  return {
    after,
    through: head,
    reset: after > head || after < floor || head - after > LIMITS.changesResetGap,
  }
}

// ───────── a conversation ─────────

export async function getConversationChanges(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  query: ChangesQuery,
): Promise<ConversationChangesResponse> {
  return await deps.db.transaction(async (tx) => {
    const now = deps.clock.now()
    const actor = { userId: principal.userId, siteRole: principal.role }
    const access = await loadAccess(tx, principal.userId, conversationId)
    enforce(access, actor, 'view', now)
    enforce(access, actor, 'read_messages', now)
    const member = access.member
    if (!member) throw new AppError('NOT_FOUND', 'Conversation not found')
    const conversation = access.conversation
    const viewer: Viewer = { userId: principal.userId, visibleFromSeq: member.visibleFromSeq }
    const limit = query.limit ?? LIMITS.changesPageDefault

    const cursor =
      query.cursor !== undefined ? decodeCursor(deps, query.cursor, 'cc', principal) : null
    const valid =
      cursor !== null &&
      cursor.c === conversationId &&
      cursor.m === member.membershipId &&
      cursor.ae === principal.authEpoch &&
      cursor.re === deps.config.auth.restoreEpoch
    const where = position(
      query,
      cursor,
      valid,
      conversation.lastChangeSeq,
      conversation.changeLogFloor,
    )

    if (where.reset) {
      const latest = await latestMessages(tx, viewer, conversationId, LIMITS.messagePageDefault)
      const projected = await projectMessages(tx, viewer, latest.rows)
      const dto = await loadConversation(tx, principal.userId, conversationId, now)
      if (!dto) throw new AppError('NOT_FOUND', 'Conversation not found')
      const mine = await userSeq(tx, principal.userId)
      return {
        items: [],
        tombstones: [],
        users: {},
        scannedThrough: conversation.lastChangeSeq,
        through: conversation.lastChangeSeq,
        nextCursor: null,
        membershipId: member.membershipId,
        resetRequired: true,
        baseline: {
          conversation: dto,
          messages: projected.messages,
          users: projected.users,
          hasMoreBefore: latest.hasMoreBefore,
          baselineChangeSeq: conversation.lastChangeSeq,
          baselineUserSeq: mine.seq,
        },
      }
    }

    const entries = await tx
      .select({
        changeSeq: conversationChanges.changeSeq,
        messageId: conversationChanges.messageId,
      })
      .from(conversationChanges)
      .where(
        and(
          eq(conversationChanges.conversationId, conversationId),
          gt(conversationChanges.changeSeq, where.after),
          lte(conversationChanges.changeSeq, where.through),
        ),
      )
      .orderBy(asc(conversationChanges.changeSeq))
      .limit(limit)
    // Fewer entries than asked for means the end of the range was reached, even if the entries were all filtered out.
    const scannedThrough =
      entries.length < limit
        ? where.through
        : (entries[entries.length - 1]?.changeSeq ?? where.through)
    const nextCursor =
      scannedThrough < where.through
        ? encodeCursor(deps, {
            k: 'cc',
            u: principal.userId,
            ae: principal.authEpoch,
            re: deps.config.auth.restoreEpoch,
            c: conversationId,
            m: member.membershipId,
            a: scannedThrough,
            t: where.through,
            x: cursorExpiry(deps),
          })
        : null

    const latestChange = new Map<string, number>()
    for (const entry of entries) {
      if (entry.messageId !== null) latestChange.set(entry.messageId, entry.changeSeq)
    }
    const ids = [...latestChange.keys()]
    const rows =
      ids.length > 0
        ? await tx
            .select()
            .from(messages)
            .where(and(eq(messages.conversationId, conversationId), inArray(messages.id, ids)))
        : []
    const hidden = new Set(
      ids.length > 0
        ? (
            await tx
              .select({ messageId: messageHidden.messageId })
              .from(messageHidden)
              .where(
                and(
                  eq(messageHidden.userId, principal.userId),
                  inArray(messageHidden.messageId, ids),
                ),
              )
          ).map((row) => row.messageId)
        : [],
    )
    const existing = new Set(rows.map((row) => row.id))
    // What the reader may see: after their boundary and not hidden. History before they joined is simply not there.
    const visible = rows
      .filter((row) => row.seq > member.visibleFromSeq && !hidden.has(row.id))
      .sort((a, b) => a.seq - b.seq)
    const projected = await projectMessages(tx, viewer, visible)
    const tombstones = ids
      .filter((id) => !existing.has(id))
      .map((id) => ({ id, changeSeq: latestChange.get(id) ?? where.through }))

    return {
      items: projected.messages,
      tombstones,
      users: projected.users,
      scannedThrough,
      through: where.through,
      nextCursor,
      membershipId: member.membershipId,
      resetRequired: false,
      baseline: null,
    }
  }, SNAPSHOT)
}

// ───────── a person ─────────

export async function getUserChanges(
  deps: Deps,
  principal: SessionPrincipal,
  query: ChangesQuery,
): Promise<UserChangesResponse> {
  return await deps.db.transaction(async (tx) => {
    const now = deps.clock.now()
    const limit = query.limit ?? LIMITS.changesPageDefault
    const mine = await userSeq(tx, principal.userId)

    const cursor =
      query.cursor !== undefined ? decodeCursor(deps, query.cursor, 'uc', principal) : null
    const valid =
      cursor !== null &&
      cursor.ae === principal.authEpoch &&
      cursor.re === deps.config.auth.restoreEpoch
    const where = position(query, cursor, valid, mine.seq, mine.floor)

    if (where.reset) {
      const me = await loadMe(tx, deps, principal.userId)
      if (!me) throw new AppError('UNAUTHENTICATED', 'Session is no longer valid')
      return {
        items: [],
        scannedThrough: mine.seq,
        through: mine.seq,
        nextCursor: null,
        resetRequired: true,
        baseline: {
          me,
          conversations: await loadLiveConversations(tx, principal.userId, now),
          baselineUserSeq: mine.seq,
        },
      }
    }

    const entries = await tx
      .select({
        changeSeq: userChanges.changeSeq,
        entityType: userChanges.entityType,
        entityId: userChanges.entityId,
      })
      .from(userChanges)
      .where(
        and(
          eq(userChanges.userId, principal.userId),
          gt(userChanges.changeSeq, where.after),
          lte(userChanges.changeSeq, where.through),
        ),
      )
      .orderBy(asc(userChanges.changeSeq))
      .limit(limit)
    const scannedThrough =
      entries.length < limit
        ? where.through
        : (entries[entries.length - 1]?.changeSeq ?? where.through)
    const nextCursor =
      scannedThrough < where.through
        ? encodeCursor(deps, {
            k: 'uc',
            u: principal.userId,
            ae: principal.authEpoch,
            re: deps.config.auth.restoreEpoch,
            a: scannedThrough,
            t: where.through,
            x: cursorExpiry(deps),
          })
        : null

    // Several entries about one entity are one question: what is it now?
    const latest = new Map<string, { type: string; id: string; seq: number }>()
    for (const entry of entries) {
      latest.set(`${entry.entityType}:${entry.entityId}`, {
        type: entry.entityType,
        id: entry.entityId,
        seq: entry.changeSeq,
      })
    }
    const ordered = [...latest.values()].sort((a, b) => a.seq - b.seq)

    const conversationIds = ordered
      .filter((entry) => entry.type === 'conversation')
      .map((entry) => entry.id)
    const views = await loadConversationsByIds(tx, principal.userId, conversationIds, now)
    const states = conversationIds.length
      ? await tx
          .select()
          .from(userConversationStates)
          .where(
            and(
              eq(userConversationStates.userId, principal.userId),
              inArray(userConversationStates.conversationId, conversationIds),
            ),
          )
      : []
    const stateOf = new Map(states.map((row) => [row.conversationId, row]))

    const hiddenIds = ordered
      .filter((entry) => entry.type === 'message_hidden')
      .map((entry) => entry.id)
    const hiddenRows = hiddenIds.length
      ? await tx
          .select({ id: messages.id, conversationId: messages.conversationId, seq: messages.seq })
          .from(messages)
          .where(inArray(messages.id, hiddenIds))
      : []
    const hiddenIn = new Map(hiddenRows.map((row) => [row.id, row]))
    const memberships = hiddenRows.length
      ? await tx
          .select({
            conversationId: conversationMembers.conversationId,
            visibleFromSeq: conversationMembers.visibleFromSeq,
          })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.userId, principal.userId),
              inArray(conversationMembers.conversationId, [
                ...new Set(hiddenRows.map((row) => row.conversationId)),
              ]),
            ),
          )
      : []
    const boundary = new Map(memberships.map((row) => [row.conversationId, row.visibleFromSeq]))

    const items: UserChangeItem[] = []
    for (const entry of ordered) {
      if (entry.type === 'conversation') {
        const view: Conversation | undefined = views.get(entry.id)
        if (view?.me) {
          items.push({ type: 'conversation', conversation: view })
          continue
        }
        // Not a member (any more): the tombstone, so an older cache is dropped and a later re-entry still wins by version.
        const state = stateOf.get(entry.id)
        items.push({
          type: 'conversation.removed',
          conversationId: entry.id,
          membershipId: state?.membershipId ?? null,
          state: 'removed',
          viewerVersion: state?.viewerVersion ?? entry.seq,
        })
      } else if (entry.type === 'message_hidden') {
        const message = hiddenIn.get(entry.id)
        const from = message ? boundary.get(message.conversationId) : undefined
        if (message && from !== undefined && message.seq > from) {
          items.push({
            type: 'message.hidden',
            conversationId: message.conversationId,
            messageId: message.id,
          })
        }
      } else if (entry.type === 'me') {
        const me = await loadMe(tx, deps, principal.userId)
        if (me) items.push({ type: 'me', me })
      }
    }
    return {
      items,
      scannedThrough,
      through: where.through,
      nextCursor,
      resetRequired: false,
      baseline: null,
    }
  }, SNAPSHOT)
}

// ───────── heads ─────────

/** Versions only, for the reconciliation poll: where each of my conversations stands, and where my own log stands. */
export async function getSyncHeads(
  deps: Deps,
  principal: SessionPrincipal,
): Promise<SyncHeadsResponse> {
  return await deps.db.transaction(async (tx) => {
    const mine = await userSeq(tx, principal.userId)
    const rows = await tx
      .select({
        id: conversations.id,
        membershipId: conversationMembers.membershipId,
        lastChangeSeq: conversations.lastChangeSeq,
        metadataVersion: conversations.metadataVersion,
        membershipVersion: conversations.membershipVersion,
        stateVersion: conversationMembers.stateVersion,
        viewerVersion: userConversationStates.viewerVersion,
      })
      .from(conversationMembers)
      .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
      .leftJoin(
        userConversationStates,
        and(
          eq(userConversationStates.conversationId, conversationMembers.conversationId),
          eq(userConversationStates.userId, conversationMembers.userId),
        ),
      )
      .where(eq(conversationMembers.userId, principal.userId))
      .orderBy(asc(conversations.id))
    return {
      userChangeSeq: mine.seq,
      conversations: rows.map((row) => ({
        id: row.id,
        membershipId: row.membershipId,
        lastChangeSeq: row.lastChangeSeq,
        metadataVersion: row.metadataVersion,
        membershipVersion: row.membershipVersion,
        viewerVersion: row.viewerVersion ?? row.stateVersion,
      })),
    }
  }, SNAPSHOT)
}
