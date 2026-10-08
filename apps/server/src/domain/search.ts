import { AppError, type MessageSearchQuery, type MessageSearchResponse } from '@chatapp/contracts'
import {
  conversationMembers,
  conversations,
  type DbOrTx,
  messageHidden,
  messages,
} from '@chatapp/db'
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  notExists,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm'
import { requireAccess } from './authorize.ts'
import { cursorExpiry, decodeCursor, encodeCursor } from './cursor.ts'
import type { Deps } from './deps.ts'
import { type MessageRow, projectMessages } from './messages.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate } from './sessions.ts'

export type SearchFilter = {
  order?: 'id' | 'seq'
  conversationIds?: string[]
  from?: string
  after?: string
  before?: string
  beforeId?: string
  messageId?: string
  /** A running Agent's prompt and unfinished output are instructions, never retrieval evidence. */
  excludeMessageIds?: string[]
  /** Shared output additionally applies every current member's boundary. */
  shared?: boolean
  siteInput?: boolean
  limit: number
  query?: string
  beforeSeq?: number
  afterSeq?: number
}

/** The same SQL predicate backs ordinary search and all Agent reads. No unauthorized row is paginated or scored. */
export function visibleMessagePredicate(db: DbOrTx, userId: string, filter: SearchFilter): SQL {
  const conditions: (SQL | undefined)[] = [
    eq(conversationMembers.userId, userId),
    gt(messages.seq, conversationMembers.visibleFromSeq),
    isNull(messages.recalledAt),
    isNull(messages.deletedAt),
    notExists(
      db
        .select({ one: sql`1` })
        .from(messageHidden)
        .where(and(eq(messageHidden.userId, userId), eq(messageHidden.messageId, messages.id))),
    ),
    filter.conversationIds ? inArray(messages.conversationId, filter.conversationIds) : undefined,
    filter.from ? eq(messages.senderId, filter.from) : undefined,
    filter.after ? gt(messages.createdAt, new Date(filter.after)) : undefined,
    filter.before ? lt(messages.createdAt, new Date(filter.before)) : undefined,
    filter.beforeId ? lt(messages.id, filter.beforeId) : undefined,
    filter.messageId ? eq(messages.id, filter.messageId) : undefined,
    filter.excludeMessageIds?.length
      ? notInArray(messages.id, filter.excludeMessageIds)
      : undefined,
    filter.beforeSeq !== undefined ? lt(messages.seq, filter.beforeSeq) : undefined,
    filter.afterSeq !== undefined ? gt(messages.seq, filter.afterSeq) : undefined,
    filter.query
      ? sql`${messages.body} ilike ${`%${filter.query.replace(/[\\%_]/g, '\\$&')}%`}`
      : undefined,
    filter.siteInput ? eq(messages.privacyClass, 'standard') : undefined,
    filter.siteInput
      ? sql`(${messages.kind} <> 'agent' or exists (select 1 from agent_runs ar where ar.id::text = ${messages.meta}->'agent'->>'runId' and ar.status = 'completed' and ar.privacy_class = 'standard' and ar.content_purged_at is null))`
      : undefined,
    filter.shared
      ? sql`${messages.seq} > (select coalesce(max(cm.visible_from_seq), 0) from conversation_members cm where cm.conversation_id = ${messages.conversationId})`
      : undefined,
  ]
  return and(...conditions) ?? sql`false`
}

export async function findVisibleMessages(
  db: DbOrTx,
  userId: string,
  filter: SearchFilter,
): Promise<MessageRow[]> {
  if (filter.conversationIds?.length === 0) return []
  return await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(conversationMembers, eq(conversationMembers.conversationId, messages.conversationId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(visibleMessagePredicate(db, userId, filter))
    .orderBy(filter.order === 'seq' ? desc(messages.seq) : desc(messages.id))
    .limit(filter.limit)
    .then((rows) => rows.map((r) => r.message))
}

export async function searchMessages(
  deps: Deps,
  principal: SessionPrincipal,
  query: MessageSearchQuery,
): Promise<MessageSearchResponse> {
  return await deps.db.transaction(async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    if (query.conversationId)
      await requireAccess(
        tx,
        { userId: principal.userId, siteRole: principal.role },
        query.conversationId,
        'read_messages',
        { now: deps.clock.now() },
      )
    const scope = query.conversationId ?? ''
    const cursor = query.cursor ? decodeCursor(deps, query.cursor, 'search', principal) : null
    if (
      query.cursor &&
      (!cursor ||
        cursor.q !== query.query ||
        cursor.c !== scope ||
        cursor.ae !== principal.authEpoch ||
        cursor.re !== principal.restoreEpoch)
    )
      throw new AppError('VALIDATION_FAILED', 'Invalid search cursor')
    const rows = await findVisibleMessages(tx, principal.userId, {
      query: query.query,
      conversationIds: query.conversationId ? [query.conversationId] : undefined,
      beforeId: cursor?.o,
      limit: query.limit + 1,
    })
    const page = rows.slice(0, query.limit)
    const memberships = await tx
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.userId, principal.userId))
    const projected: Pick<MessageSearchResponse, 'messages' | 'users'> = { messages: [], users: {} }
    for (const membership of memberships) {
      const group = page.filter((r) => r.conversationId === membership.conversationId)
      if (!group.length) continue
      const result = await projectMessages(
        tx,
        { userId: principal.userId, visibleFromSeq: membership.visibleFromSeq },
        group,
      )
      projected.messages.push(...result.messages)
      Object.assign(projected.users, result.users)
    }
    const order = new Map(page.map((r, i) => [r.id, i]))
    projected.messages.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    const last = page.at(-1)
    return {
      ...projected,
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(deps, {
              k: 'search',
              u: principal.userId,
              ae: principal.authEpoch,
              re: principal.restoreEpoch,
              q: query.query,
              c: scope,
              o: last.id,
              x: cursorExpiry(deps),
            })
          : null,
    }
  })
}
