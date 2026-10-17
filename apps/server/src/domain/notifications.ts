/**
 * The in-site notification centre (docs/01 section 4.8, docs/04 section 6, docs/05 section 3.7, M6).
 *
 * A row says "this happened to you" with identifiers only. What a reader sees is projected when it is read, with their
 * access at that moment: a conversation they left, a message that was hidden from them or a run that is gone turns the entry
 * into a generic `{ available: false }`, and nothing of what was there before is returned (docs/04 section 6). Creating an
 * entry takes the person's next personal change number, so a device that missed the `notification` hint finds it in its
 * personal log (`recordNotificationChange`).
 */
import {
  AppError,
  LIMITS,
  type MarkNotificationsRead,
  type MarkNotificationsReadResponse,
  markdownPreviewText,
  mentionIds,
  type Notification,
  type NotificationPage,
  type NotificationsQuery,
  type NotificationType,
  plainMessageText,
  truncateCodePoints,
} from '@chatapp/contracts'
import {
  agentApprovals,
  agentRuns,
  attachments,
  conversationMembers,
  conversations,
  type DbOrTx,
  deletionLocks,
  messageHidden,
  messages,
  notifications,
  reports,
  users,
  workItems,
} from '@chatapp/db'
import { and, desc, eq, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import { recordNotificationChange } from './changes.ts'
import { cursorExpiry, decodeCursor, encodeCursor } from './cursor.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { accountAllowsSession, lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'
import { usersDictionary } from './users.ts'
import { enqueueWork } from './work.ts'
import type { WorkLease } from './work-queue.ts'

type Row = typeof notifications.$inferSelect

/** Freeze the recipients with the report, without acquiring other users' sequence locks. */
export async function enqueueAdminNotifications(
  tx: DbOrTx,
  deps: Deps,
  data: { reportId: string },
) {
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, 'admin'),
        eq(users.activationStatus, 'active'),
        eq(users.isBot, false),
        or(eq(users.banned, false), lte(users.banExpires, deps.clock.now())),
        eq(users.emailVerified, true),
        isNull(users.deletedAt),
      ),
    )
  for (const admin of admins)
    await enqueueWork(tx, deps, {
      kind: 'notification',
      dedupeKey: `report:${data.reportId}:admin:${admin.id}`,
      entityId: data.reportId,
      payload: { reportId: data.reportId, userId: admin.id },
    })
  await tx
    .update(reports)
    .set({ notificationsQueuedAt: deps.clock.now() })
    .where(eq(reports.id, data.reportId))
}

/** Upgrade compensation for open reports created before durable notification intents existed. */
export async function reconcileReportNotifications(deps: Deps, limit = 100): Promise<number> {
  return await inTransaction(deps.db, async (tx) => {
    const rows = await tx
      .select({ id: reports.id })
      .from(reports)
      .where(and(eq(reports.status, 'open'), isNull(reports.notificationsQueuedAt)))
      .orderBy(reports.createdAt, reports.id)
      .limit(limit)
      .for('update', { skipLocked: true })
    for (const row of rows) await enqueueAdminNotifications(tx, deps, { reportId: row.id })
    return rows.length
  })
}

/** Notification and completion commit together. A crash or failed recipient leaves durable retryable work. */
export async function deliverAdminNotification(deps: Deps, lease: WorkLease): Promise<void> {
  await deps.faultPoint?.('notification.before')
  const [candidate] = await deps.db
    .select({ payload: workItems.payload })
    .from(workItems)
    .where(eq(workItems.id, lease.id))
  const recipient = candidate?.payload.userId
  if (typeof recipient !== 'string') throw new Error('invalid administrator notification recipient')
  await inTransaction(deps.db, async (tx) => {
    // Users precede work and notification rows throughout the domain lock order.
    const [admin] = await tx.select().from(users).where(eq(users.id, recipient)).for('update')
    const [work] = await tx
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.id, lease.id),
          eq(workItems.kind, 'notification'),
          eq(workItems.leaseEpoch, lease.leaseEpoch),
          eq(workItems.status, 'leased'),
        ),
      )
      .for('update')
    if (!work) return
    const { userId, reportId } = work.payload
    if (typeof userId !== 'string' || typeof reportId !== 'string')
      throw new Error('invalid administrator notification work')
    if (userId !== recipient) throw new Error('administrator notification recipient changed')
    const [frozen] = await tx
      .select({ id: deletionLocks.operationId })
      .from(deletionLocks)
      .where(and(eq(deletionLocks.targetType, 'user'), eq(deletionLocks.targetId, userId)))
    if (!frozen && admin?.role === 'admin' && accountAllowsSession(admin, deps.clock.now()))
      await createNotification(tx, deps, {
        userId,
        type: 'report_opened',
        dedupeKey: `report:${reportId}`,
        data: { reportId },
      })
    await tx
      .update(workItems)
      .set({ status: 'done', finishedAt: deps.clock.now(), leaseUntil: null, lastErrorCode: null })
      .where(eq(workItems.id, work.id))
  })
  await deps.faultPoint?.('notification.after')
}

export type NotificationSeed = {
  userId: string
  type: NotificationType
  /** One entry per cause and person: the same message, approval or reminder derives the same key (docs/04 section 6). */
  dedupeKey: string
  /** Identifiers and times only. */
  data: Record<string, string | number | null>
}

/**
 * Records an entry for a person, once per `dedupeKey`. Runs in the transaction of the event it reports (an approval being
 * registered, a reminder being delivered) or in its own short one (a message being derived). Returns whether it is new.
 */
export async function createNotification(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock' | 'newId'>,
  seed: NotificationSeed,
): Promise<{ id: string; created: boolean }> {
  const id = deps.newId()
  const inserted = await tx
    .insert(notifications)
    .values({
      id,
      userId: seed.userId,
      type: seed.type,
      dedupeKey: seed.dedupeKey,
      data: seed.data,
      createdAt: deps.clock.now(),
    })
    .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
    .returning({ id: notifications.id })
  if (inserted[0]) {
    await recordNotificationChange(tx, deps, { userId: seed.userId, notificationId: id })
    return { id, created: true }
  }
  const [existing] = await tx
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, seed.userId), eq(notifications.dedupeKey, seed.dedupeKey)))
  if (!existing) throw new Error('notification vanished between insert and select')
  return { id: existing.id, created: false }
}

/**
 * An entry for every site administrator (a budget alert, later a new report). Each gets it in a transaction of their own, so
 * the caller's locks never meet an administrator's row.
 */
export async function notifyAdmins(
  deps: Deps,
  seed: Omit<NotificationSeed, 'userId'>,
): Promise<number> {
  const admins = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, 'admin'),
        eq(users.activationStatus, 'active'),
        eq(users.isBot, false),
        isNull(users.deletedAt),
      ),
    )
  let created = 0
  for (const admin of admins) {
    const result = await inTransaction(deps.db, (tx) =>
      createNotification(tx, deps, { ...seed, userId: admin.id }),
    )
    if (result.created) created += 1
  }
  return created
}

// ───────── projection ─────────

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/**
 * What the reader may be shown for each stored entry, in the order given. Everything is looked up in a handful of batched
 * queries; an entry whose source is not the reader's to see becomes `{ available: false }`.
 */
export async function projectNotifications(
  db: DbOrTx,
  viewer: { userId: string },
  rows: readonly Row[],
): Promise<Notification[]> {
  const messageIds = new Set<string>()
  const approvalIds = new Set<string>()
  for (const row of rows) {
    if (row.type === 'mention' || row.type === 'reply' || row.type === 'reminder') {
      const id = str(row.data.messageId)
      if (id) messageIds.add(id)
    } else if (row.type === 'approval_requested') {
      const id = str(row.data.approvalId)
      if (id) approvalIds.add(id)
    }
  }

  const messageRows = messageIds.size
    ? await db
        .select({
          id: messages.id,
          conversationId: messages.conversationId,
          seq: messages.seq,
          senderId: messages.senderId,
          body: messages.body,
          recalledAt: messages.recalledAt,
          deletedAt: messages.deletedAt,
          attachmentKind: sql<
            'image' | 'video' | 'audio' | 'file' | null
          >`(select a.kind from ${attachments} a where a.message_id = "messages"."id" and a.status = 'ready' and a.privacy_class = 'standard' order by a.position limit 1)`,
        })
        .from(messages)
        .where(inArray(messages.id, [...messageIds]))
    : []
  const messageOf = new Map(messageRows.map((row) => [row.id, row]))
  const conversationIds = [...new Set(messageRows.map((row) => row.conversationId))]

  const [conversationRows, memberRows, hiddenRows] = conversationIds.length
    ? await Promise.all([
        db
          .select({ id: conversations.id, kind: conversations.kind, name: conversations.name })
          .from(conversations)
          .where(inArray(conversations.id, conversationIds)),
        db
          .select({
            conversationId: conversationMembers.conversationId,
            visibleFromSeq: conversationMembers.visibleFromSeq,
          })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.userId, viewer.userId),
              inArray(conversationMembers.conversationId, conversationIds),
            ),
          ),
        db
          .select({ messageId: messageHidden.messageId })
          .from(messageHidden)
          .where(
            and(
              eq(messageHidden.userId, viewer.userId),
              inArray(messageHidden.messageId, [...messageIds]),
            ),
          ),
      ])
    : [[], [], []]
  const conversationOf = new Map(conversationRows.map((row) => [row.id, row]))
  const boundaryOf = new Map(memberRows.map((row) => [row.conversationId, row.visibleFromSeq]))
  const hidden = new Set(hiddenRows.map((row) => row.messageId))

  // People: the senders, and whoever the visible previews mention (their names replace the stored ids).
  const people = new Set<string>()
  const readable = (messageId: string | null) => {
    const message = messageId ? messageOf.get(messageId) : undefined
    if (!message) return undefined
    const boundary = boundaryOf.get(message.conversationId)
    if (boundary === undefined || message.seq <= boundary || hidden.has(message.id))
      return undefined
    if (!conversationOf.has(message.conversationId)) return undefined
    return message
  }
  for (const row of rows) {
    const message = readable(str(row.data.messageId))
    if (!message) continue
    if (message.senderId) people.add(message.senderId)
    if (!message.recalledAt && !message.deletedAt) {
      for (const id of mentionIds(message.body ?? '')) people.add(id)
    }
  }
  const dictionary = await usersDictionary(db, people)

  const approvalRows = approvalIds.size
    ? await db
        .select({
          id: agentApprovals.id,
          runId: agentApprovals.runId,
          status: agentApprovals.status,
          expiresAt: agentApprovals.expiresAt,
          conversationId: agentRuns.conversationId,
        })
        .from(agentApprovals)
        .innerJoin(agentRuns, eq(agentRuns.id, agentApprovals.runId))
        .where(
          and(
            inArray(agentApprovals.id, [...approvalIds]),
            eq(agentApprovals.userId, viewer.userId),
          ),
        )
    : []
  const approvalOf = new Map(approvalRows.map((row) => [row.id, row]))

  const messageRef = (message: NonNullable<ReturnType<typeof readable>>) => {
    const withdrawn = message.recalledAt !== null || message.deletedAt !== null
    const text =
      withdrawn || (message.body === null && message.attachmentKind === null)
        ? null
        : truncateCodePoints(
            plainMessageText(
              markdownPreviewText(message.body),
              (id) => dictionary[id]?.displayName,
              message.attachmentKind,
            ),
            LIMITS.excerptMaxCodePoints,
          )
    return {
      id: message.id,
      seq: message.seq,
      preview: text === '' ? null : text,
      ...(!withdrawn && message.attachmentKind ? { attachmentKind: message.attachmentKind } : {}),
      recalled: withdrawn,
    }
  }
  const conversationRef = (id: string) => {
    const conversation = conversationOf.get(id)
    return conversation
      ? {
          id: conversation.id,
          kind: conversation.kind,
          name: conversation.kind === 'dm' ? null : conversation.name,
        }
      : null
  }

  const out: Notification[] = []
  for (const row of rows) {
    const base = {
      id: row.id,
      version: row.version,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }
    const unavailable = { available: false as const }
    switch (row.type) {
      case 'mention':
      case 'reply': {
        const message = readable(str(row.data.messageId))
        const sender = message?.senderId ? dictionary[message.senderId] : undefined
        const conversation = message ? conversationRef(message.conversationId) : null
        out.push({
          ...base,
          type: row.type,
          data:
            message && sender && conversation
              ? { available: true, conversation, message: messageRef(message), sender }
              : unavailable,
        })
        break
      }
      case 'reminder': {
        const message = readable(str(row.data.messageId))
        const conversation = message ? conversationRef(message.conversationId) : null
        out.push({
          ...base,
          type: 'reminder',
          data:
            message && conversation
              ? { available: true, conversation, message: messageRef(message) }
              : unavailable,
        })
        break
      }
      case 'approval_requested': {
        const approval = approvalOf.get(str(row.data.approvalId) ?? '')
        out.push({
          ...base,
          type: 'approval_requested',
          data: approval
            ? {
                available: true,
                approval: {
                  id: approval.id,
                  runId: approval.runId,
                  status: approval.status,
                  expiresAt: approval.expiresAt.toISOString(),
                },
                conversationId: approval.conversationId,
              }
            : unavailable,
        })
        break
      }
      case 'budget_alert':
        out.push({
          ...base,
          type: 'budget_alert',
          data: {
            period: str(row.data.period) ?? '',
            percent: row.data.percent === 100 ? 100 : 80,
          },
        })
        break
      case 'report_opened':
        // Reports arrive with M7; until then nothing creates this entry, and a stray one shows nothing of its source.
        out.push({ ...base, type: 'report_opened', data: unavailable })
        break
    }
  }
  return out
}

// ───────── reading ─────────

/** Site budget alerts are for administrators; a demoted one stops seeing them. */
const visibleTypes = (isAdmin: boolean) =>
  isAdmin ? undefined : ne(notifications.type, 'budget_alert')

async function roleOf(db: DbOrTx, userId: string): Promise<boolean> {
  const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId))
  if (!row) throw new AppError('UNAUTHENTICATED', 'Session is no longer valid')
  return row.role === 'admin'
}

export async function unreadNotificationCount(
  db: DbOrTx,
  userId: string,
  isAdmin: boolean,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(eq(notifications.userId, userId), isNull(notifications.readAt), visibleTypes(isAdmin)),
    )
  return row?.n ?? 0
}

/** The current state of entries a personal-log entry names (docs/05 section 4.5); entries that are gone are simply absent. */
export async function loadNotificationsByIds(
  db: DbOrTx,
  userId: string,
  ids: readonly string[],
): Promise<Notification[]> {
  if (ids.length === 0) return []
  const isAdmin = await roleOf(db, userId)
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        inArray(notifications.id, [...ids]),
        visibleTypes(isAdmin),
      ),
    )
  return await projectNotifications(db, { userId }, rows)
}

/** Newest first. The cursor is signed and carries the position of the last entry of the previous page. */
export async function listNotifications(
  deps: Deps,
  principal: SessionPrincipal,
  query: NotificationsQuery,
): Promise<NotificationPage> {
  const limit = query.limit ?? LIMITS.notificationsPageDefault
  const cursor = query.cursor ? decodeCursor(deps, query.cursor, 'notif', principal) : null
  if (query.cursor && cursor === null) {
    throw new AppError('VALIDATION_FAILED', 'The cursor is not valid', {
      details: { field: 'cursor' },
    })
  }
  return await deps.db.transaction(
    async (tx) => {
      const isAdmin = await roleOf(tx, principal.userId)
      const rows = await tx
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, principal.userId),
            visibleTypes(isAdmin),
            cursor
              ? or(
                  lt(notifications.createdAt, new Date(cursor.o[0])),
                  and(
                    eq(notifications.createdAt, new Date(cursor.o[0])),
                    lt(notifications.id, cursor.o[1]),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit + 1)
      const page = rows.slice(0, limit)
      const last = page[page.length - 1]
      const nextCursor =
        rows.length > limit && last
          ? encodeCursor(deps, {
              k: 'notif',
              u: principal.userId,
              o: [last.createdAt.toISOString(), last.id],
              x: cursorExpiry(deps),
            })
          : null
      return {
        items: await projectNotifications(tx, principal, page),
        nextCursor,
        unreadCount: await unreadNotificationCount(tx, principal.userId, isAdmin),
      }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

// ───────── marking read ─────────

/** Marking is idempotent: an entry already read is left alone, and ids that are not the caller's are ignored without a word. */
export async function markNotificationsRead(
  deps: Deps,
  principal: SessionPrincipal,
  request: MarkNotificationsRead,
): Promise<MarkNotificationsReadResponse> {
  return await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal)
    const isAdmin = user.role === 'admin'
    const now = deps.clock.now()
    const target = 'ids' in request ? inArray(notifications.id, request.ids) : undefined
    const picked = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, principal.userId),
          isNull(notifications.readAt),
          visibleTypes(isAdmin),
          target,
        ),
      )
      // One request moves at most this many; a person with more unread entries than that presses the button again.
      .limit(1000)
      .for('update')
    const ids = picked.map((row) => row.id)
    const changed = ids.length
      ? await tx
          .update(notifications)
          .set({ readAt: now, version: sql`${notifications.version} + 1` })
          .where(inArray(notifications.id, ids))
          .returning()
      : []
    // Every entry takes a personal change number; one hint, at the end, is enough to wake the other devices.
    for (const [index, row] of changed.entries()) {
      await recordNotificationChange(tx, deps, {
        userId: principal.userId,
        notificationId: row.id,
        silent: index < changed.length - 1,
      })
    }
    return {
      items: 'ids' in request ? await projectNotifications(tx, principal, changed) : [],
      unreadCount: await unreadNotificationCount(tx, principal.userId, isAdmin),
    }
  })
}

// ───────── retention ─────────

/** Entries are kept 90 days (docs/01 section 7). Run by the cleanup job; returns how many were removed. */
export async function purgeExpiredNotifications(deps: Deps, batch = 1000): Promise<number> {
  const cutoff = new Date(
    deps.clock.now().getTime() - LIMITS.notificationRetentionDays * 86_400_000,
  )
  const removed = await deps.db.execute<{ id: string }>(
    sql`delete from ${notifications} where ${notifications.id} in (
      select ${notifications.id} from ${notifications} where ${notifications.createdAt} < ${cutoff} limit ${batch}
    ) returning ${notifications.id} as id`,
  )
  return removed.length
}
