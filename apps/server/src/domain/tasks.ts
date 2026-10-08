/**
 * Reminders and scheduled messages (M5a; docs/04 section 7, docs/06 section 4.2, docs/03 sections 5.9 and 7).
 *
 * A task is created by an approved (or automatic) assistant effect and runs later under its own child delegation: it
 * inherits the device and account generation of the run that created it, so cancelling the run leaves it alone while a
 * security revocation of that device ends it (the docs/03 truth table). The instant is UTC; the wall-clock reading it was
 * agreed in is kept beside it and a later time zone change never moves it (INV-30). Delivery re-checks the delegation and
 * the business rights under the same lock order as any write, never advances anyone's read position (INV-28), fails
 * rather than sends more than 24 hours late, and is serialized with cancellation by the person's lock.
 */
import {
  AppError,
  type PrivacyClass,
  type Reminder,
  type ScheduledMessage,
  type TaskListQuery,
} from '@chatapp/contracts'
import {
  authorizationOrigins,
  conversations,
  type DbOrTx,
  executionDelegations,
  messages,
  reminders,
  scheduledMessages,
  type Tx,
  users,
  workItems,
} from '@chatapp/db'
import { and, desc, eq, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm'
import { uuidV5 } from '../lib/crypto.ts'
import { requireAccess } from './authorize.ts'
import { allocateMessageSeq, recordMessageChange } from './changes.ts'
import { conversationRefFor } from './conversation-refs.ts'
import { cursorExpiry, decodeCursor, encodeCursor } from './cursor.ts'
import type { Deps } from './deps.ts'
import { addMembers } from './membership.ts'
import { directPeerOf, writeMessage } from './messages.ts'
import type { DelegatedPrincipal, SessionPrincipal } from './principal.ts'
import { accountAllowsSession, lockAndRevalidate, lockUsers } from './sessions.ts'
import { inTransaction } from './tx.ts'
import { enqueueWork } from './work.ts'

export const TASK_LIMITS = {
  /** Reminders and scheduled messages still to run, per person (docs/01 section 7). */
  maxFuturePerUser: 100,
  maxAheadMs: 365 * 86_400_000,
  /** A task more than this late fails instead of being delivered (docs/04). */
  graceMs: 24 * 3_600_000,
  contentRetentionMs: 30 * 86_400_000,
} as const

export type TaskKind = 'reminder' | 'scheduled_message'
export type ReminderRow = typeof reminders.$inferSelect
export type ScheduledMessageRow = typeof scheduledMessages.$inferSelect
type TaskRow = ReminderRow | ScheduledMessageRow

const tableOf = (kind: TaskKind) => (kind === 'reminder' ? reminders : scheduledMessages)
const dueOf = (row: TaskRow): Date => ('remindAt' in row ? row.remindAt : row.sendAt)
const notFound = (kind: TaskKind) =>
  new AppError(
    'NOT_FOUND',
    kind === 'reminder' ? 'Reminder not found' : 'Scheduled message not found',
  )

/** What is wrong with running a task at `at`, seen from `now`; null when nothing is. */
export function taskTimeProblem(at: Date, now: Date): 'TIME_IN_PAST' | 'TOO_FAR_AHEAD' | null {
  if (at.getTime() <= now.getTime()) return 'TIME_IN_PAST'
  if (at.getTime() - now.getTime() > TASK_LIMITS.maxAheadMs) return 'TOO_FAR_AHEAD'
  return null
}

export async function futureTaskCount(db: DbOrTx, userId: string): Promise<number> {
  const [a] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reminders)
    .where(and(eq(reminders.userId, userId), eq(reminders.status, 'scheduled')))
  const [b] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.userId, userId), eq(scheduledMessages.status, 'scheduled')))
  return (a?.n ?? 0) + (b?.n ?? 0)
}

/** Caller holds the person's lock, so two effects cannot both take the hundredth place. */
export async function assertTaskCapacity(tx: DbOrTx, userId: string): Promise<void> {
  if ((await futureTaskCount(tx, userId)) >= TASK_LIMITS.maxFuturePerUser)
    throw new AppError('QUOTA_EXCEEDED', 'There are as many future tasks as allowed', {
      details: { resource: 'tasks', limit: TASK_LIMITS.maxFuturePerUser },
    })
}

async function taskChanged(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  row: Pick<TaskRow, 'id' | 'userId' | 'version'>,
  kind: TaskKind,
): Promise<void> {
  await enqueueWork(tx, deps, {
    kind: 'realtime',
    dedupeKey: `tc:${row.id}:${row.version}`,
    entityId: row.userId,
    entityVersion: row.version,
    payload: { event: 'task.changed', taskType: kind, taskId: row.id },
  })
}

/**
 * The child delegation of a task: same device and account generation as the run that created it, bound to this task and
 * its frozen arguments, valid until the grace period after the due time (D-079).
 */
async function issueTaskDelegation(
  tx: Tx,
  deps: Pick<Deps, 'clock' | 'newId'>,
  principal: DelegatedPrincipal,
  kind: TaskKind,
  targetId: string,
  argsHash: string,
  at: Date,
): Promise<string> {
  const id = deps.newId()
  await tx.insert(executionDelegations).values({
    id,
    userId: principal.userId,
    originId: principal.originId,
    parentId: principal.delegationId,
    authEpoch: principal.authEpoch,
    restoreEpoch: principal.restoreEpoch,
    purpose: kind,
    targetType: kind,
    targetId,
    argsHash,
    expiresAt: new Date(at.getTime() + TASK_LIMITS.graceMs),
    createdAt: deps.clock.now(),
  })
  return id
}

export type NewTaskTime = {
  at: Date
  localDateTime: string
  timezone: string
  offsetMinutes: number
}

async function enqueueDelivery(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  kind: TaskKind,
  id: string,
  at: Date,
  attempt = '0',
): Promise<void> {
  // A Postgres intent that becomes ready at the due time; nothing waits in Valkey for months (D-044).
  await enqueueWork(tx, deps, {
    kind: 'scheduled',
    dedupeKey: `sched:${kind}:${id}:${attempt}`,
    entityId: id,
    payload: { task: kind },
    availableAt: at,
  })
}

/** Inside an effect transaction: the person, their device and delegation are locked and current. */
export async function createReminderTask(
  tx: Tx,
  deps: Deps,
  principal: DelegatedPrincipal,
  input: NewTaskTime & {
    text: string
    conversationId: string | null
    privacyClass: PrivacyClass
    runId: string
    argsHash: string
  },
): Promise<ReminderRow> {
  const now = deps.clock.now()
  const problem = taskTimeProblem(input.at, now)
  if (problem)
    throw new AppError('VALIDATION_FAILED', 'The time cannot be scheduled', {
      details: { reason: problem },
    })
  await assertTaskCapacity(tx, principal.userId)
  const id = deps.newId()
  const delegationId = await issueTaskDelegation(
    tx,
    deps,
    principal,
    'reminder',
    id,
    input.argsHash,
    input.at,
  )
  const [row] = await tx
    .insert(reminders)
    .values({
      id,
      userId: principal.userId,
      conversationId: input.conversationId,
      text: input.text,
      remindAt: input.at,
      scheduledTimezone: input.timezone,
      scheduledLocalTime: input.localDateTime,
      scheduledOffsetMinutes: input.offsetMinutes,
      privacyClass: input.privacyClass,
      createdByRunId: input.runId,
      delegationId,
      createdAt: now,
    })
    .returning()
  if (!row) throw new Error('reminder was not created')
  await enqueueDelivery(tx, deps, 'reminder', id, input.at)
  await taskChanged(tx, deps, row, 'reminder')
  return row
}

export async function createScheduledMessageTask(
  tx: Tx,
  deps: Deps,
  principal: DelegatedPrincipal,
  input: NewTaskTime & { conversationId: string; body: string; runId: string; argsHash: string },
): Promise<ScheduledMessageRow> {
  const now = deps.clock.now()
  const problem = taskTimeProblem(input.at, now)
  if (problem)
    throw new AppError('VALIDATION_FAILED', 'The time cannot be scheduled', {
      details: { reason: problem },
    })
  // The person must be able to send there now; delivery checks again at the due time.
  const access = await requireAccess(
    tx,
    { userId: principal.userId, siteRole: principal.role },
    input.conversationId,
    'send_message',
    { now },
  )
  if (access.conversation.kind === 'agent')
    throw new AppError('FORBIDDEN', 'Messages cannot be scheduled into an assistant conversation')
  await assertTaskCapacity(tx, principal.userId)
  const id = deps.newId()
  const delegationId = await issueTaskDelegation(
    tx,
    deps,
    principal,
    'scheduled_message',
    id,
    input.argsHash,
    input.at,
  )
  const [row] = await tx
    .insert(scheduledMessages)
    .values({
      id,
      userId: principal.userId,
      conversationId: input.conversationId,
      body: input.body,
      sendAt: input.at,
      scheduledTimezone: input.timezone,
      scheduledLocalTime: input.localDateTime,
      scheduledOffsetMinutes: input.offsetMinutes,
      createdByRunId: input.runId,
      delegationId,
      createdAt: now,
    })
    .returning()
  if (!row) throw new Error('scheduled message was not created')
  await enqueueDelivery(tx, deps, 'scheduled_message', id, input.at)
  await taskChanged(tx, deps, row, 'scheduled_message')
  return row
}

// ───────── reading ─────────

async function taskBase(
  db: DbOrTx,
  row: TaskRow,
  viewerOriginId: string | null,
): Promise<Omit<Reminder, 'text' | 'conversation'>> {
  const [delegation] = row.delegationId
    ? await db
        .select({
          status: executionDelegations.status,
          expiresAt: executionDelegations.expiresAt,
          originId: executionDelegations.originId,
        })
        .from(executionDelegations)
        .where(eq(executionDelegations.id, row.delegationId))
    : []
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    at: dueOf(row).toISOString(),
    timezone: row.scheduledTimezone,
    localDateTime: row.scheduledLocalTime,
    offsetMinutes: row.scheduledOffsetMinutes,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    errorCode: row.errorCode,
    createdByRunId: row.createdByRunId,
    origin: delegation
      ? { id: delegation.originId, current: delegation.originId === viewerOriginId }
      : null,
    delegation: delegation
      ? { status: delegation.status, expiresAt: delegation.expiresAt.toISOString() }
      : null,
  }
}

export async function reminderDto(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  row: ReminderRow,
  viewerOriginId: string | null,
): Promise<Reminder> {
  return {
    ...(await taskBase(db, row, viewerOriginId)),
    text: row.text,
    conversation: await conversationRefFor(db, row.userId, row.conversationId, deps.clock.now()),
  }
}

export async function scheduledMessageDto(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  row: ScheduledMessageRow,
  viewerOriginId: string | null,
): Promise<ScheduledMessage> {
  return {
    ...(await taskBase(db, row, viewerOriginId)),
    body: row.body,
    conversation: await conversationRefFor(db, row.userId, row.conversationId, deps.clock.now()),
    sentMessageId: row.sentMessageId,
  }
}

async function pageOf<R extends TaskRow>(
  deps: Deps,
  principal: SessionPrincipal,
  kind: TaskKind,
  query: TaskListQuery,
): Promise<{ rows: R[]; nextCursor: string | null }> {
  const table = tableOf(kind)
  const cursor = query.cursor ? decodeCursor(deps, query.cursor, 'task', principal) : null
  if (query.cursor && (!cursor || cursor.t !== kind || cursor.s !== (query.status ?? null)))
    throw new AppError('VALIDATION_FAILED', 'The cursor does not belong to this list', {
      details: { field: 'cursor' },
    })
  const after = cursor
    ? or(
        lt(table.createdAt, new Date(cursor.o[0])),
        and(eq(table.createdAt, new Date(cursor.o[0])), lt(table.id, cursor.o[1])),
      )
    : undefined
  const rows = (await deps.db
    .select()
    .from(table)
    .where(
      and(
        eq(table.userId, principal.userId),
        query.status ? eq(table.status, query.status) : undefined,
        after,
      ),
    )
    .orderBy(desc(table.createdAt), desc(table.id))
    .limit(query.limit + 1)) as R[]
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return {
    rows: page,
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor(deps, {
            k: 'task',
            u: principal.userId,
            t: kind,
            s: query.status ?? null,
            o: [last.createdAt.toISOString(), last.id],
            x: cursorExpiry(deps),
          })
        : null,
  }
}

export async function listReminders(
  deps: Deps,
  principal: SessionPrincipal,
  query: TaskListQuery,
): Promise<{ reminders: Reminder[]; nextCursor: string | null }> {
  const { rows, nextCursor } = await pageOf<ReminderRow>(deps, principal, 'reminder', query)
  const items: Reminder[] = []
  for (const row of rows) items.push(await reminderDto(deps.db, deps, row, principal.originId))
  return { reminders: items, nextCursor }
}

export async function listScheduledMessages(
  deps: Deps,
  principal: SessionPrincipal,
  query: TaskListQuery,
): Promise<{ scheduledMessages: ScheduledMessage[]; nextCursor: string | null }> {
  const { rows, nextCursor } = await pageOf<ScheduledMessageRow>(
    deps,
    principal,
    'scheduled_message',
    query,
  )
  const items: ScheduledMessage[] = []
  for (const row of rows)
    items.push(await scheduledMessageDto(deps.db, deps, row, principal.originId))
  return { scheduledMessages: items, nextCursor }
}

// ───────── cancelling ─────────

/**
 * Cancels one task of `userId`, who is locked by the caller. The delegation row is locked before the task row (identity
 * rows come first in the lock order). A task already over answers with its end state, so a repeated cancel changes
 * nothing; somebody else's task does not exist.
 */
export async function cancelTaskRow(
  tx: Tx,
  deps: Pick<Deps, 'clock'>,
  userId: string,
  kind: TaskKind,
  id: string,
): Promise<TaskRow> {
  const table = tableOf(kind)
  const [peek] = (await tx.select().from(table).where(eq(table.id, id))) as TaskRow[]
  if (!peek || peek.userId !== userId) throw notFound(kind)
  if (peek.delegationId)
    await tx
      .select({ id: executionDelegations.id })
      .from(executionDelegations)
      .where(eq(executionDelegations.id, peek.delegationId))
      .for('update')
  const [row] = (await tx.select().from(table).where(eq(table.id, id)).for('update')) as TaskRow[]
  if (!row) throw notFound(kind)
  if (row.status !== 'scheduled') return row
  const now = deps.clock.now()
  const [updated] = (await tx
    .update(table)
    .set({
      status: 'cancelled',
      finishedAt: now,
      version: sql`${table.version} + 1`,
      ...(kind === 'reminder' ? { text: null } : { body: null }),
    })
    .where(eq(table.id, id))
    .returning()) as TaskRow[]
  if (!updated) throw notFound(kind)
  if (row.delegationId)
    await tx
      .update(executionDelegations)
      .set({ status: 'revoked', revokedAt: now })
      .where(
        and(
          eq(executionDelegations.id, row.delegationId),
          eq(executionDelegations.status, 'active'),
        ),
      )
  await taskChanged(tx, deps, updated, kind)
  return updated
}

export async function cancelReminder(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<Reminder> {
  return await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const row = (await cancelTaskRow(tx, deps, principal.userId, 'reminder', id)) as ReminderRow
    return await reminderDto(tx, deps, row, principal.originId)
  })
}

export async function cancelScheduledMessage(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<ScheduledMessage> {
  return await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const row = (await cancelTaskRow(
      tx,
      deps,
      principal.userId,
      'scheduled_message',
      id,
    )) as ScheduledMessageRow
    return await scheduledMessageDto(tx, deps, row, principal.originId)
  })
}

/**
 * A security revocation ended these delegations (docs/03 truth table): the tasks they authorized end with them, in the
 * same transaction, their content cleared. A plain sign-out never reaches here.
 */
export async function cancelTasksOfDelegations(
  tx: Tx,
  deps: Pick<Deps, 'clock'>,
  delegationIds: readonly string[],
  code: string,
): Promise<void> {
  if (delegationIds.length === 0) return
  const now = deps.clock.now()
  const ended = await tx
    .update(reminders)
    .set({
      status: 'cancelled',
      text: null,
      finishedAt: now,
      errorCode: code,
      version: sql`${reminders.version} + 1`,
    })
    .where(
      and(inArray(reminders.delegationId, [...delegationIds]), eq(reminders.status, 'scheduled')),
    )
    .returning()
  for (const row of ended) await taskChanged(tx, deps, row, 'reminder')
  const unsent = await tx
    .update(scheduledMessages)
    .set({
      status: 'cancelled',
      body: null,
      finishedAt: now,
      errorCode: code,
      version: sql`${scheduledMessages.version} + 1`,
    })
    .where(
      and(
        inArray(scheduledMessages.delegationId, [...delegationIds]),
        eq(scheduledMessages.status, 'scheduled'),
      ),
    )
    .returning()
  for (const row of unsent) await taskChanged(tx, deps, row, 'scheduled_message')
}

// ───────── delivering ─────────

/** The person's private reminder conversation, created on first use under their lock (one per person, unique index). */
async function remindersConversation(
  tx: Tx,
  deps: Pick<Deps, 'clock' | 'newId'>,
  userId: string,
): Promise<string> {
  const [existing] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.ownerId, userId), eq(conversations.agentPurpose, 'reminders')))
    .for('update')
  if (existing) return existing.id
  const id = deps.newId()
  const now = deps.clock.now()
  await tx.insert(conversations).values({
    id,
    kind: 'agent',
    name: '提醒',
    ownerId: userId,
    createdBy: userId,
    agentPurpose: 'reminders',
    createdAt: now,
    updatedAt: now,
  })
  await addMembers(
    tx,
    deps,
    { id, kind: 'agent', lastSeq: 0 },
    [{ userId, role: 'owner', addedBy: null }],
    { fromStart: true },
  )
  return id
}

type DeliveryOutcome = 'sent' | 'failed' | 'skipped'

async function finishTask(
  tx: Tx,
  deps: Pick<Deps, 'clock'>,
  kind: TaskKind,
  row: TaskRow,
  outcome: { status: 'sent'; messageId: string } | { status: 'failed'; code: string },
): Promise<void> {
  const table = tableOf(kind)
  const now = deps.clock.now()
  const [updated] = (await tx
    .update(table)
    .set({
      status: outcome.status,
      finishedAt: now,
      version: sql`${table.version} + 1`,
      ...(outcome.status === 'sent'
        ? { sentMessageId: outcome.messageId }
        : { errorCode: outcome.code }),
    })
    .where(eq(table.id, row.id))
    .returning()) as TaskRow[]
  if (row.delegationId)
    await tx
      .update(executionDelegations)
      .set({ status: outcome.status === 'sent' ? 'completed' : 'expired' })
      .where(
        and(
          eq(executionDelegations.id, row.delegationId),
          eq(executionDelegations.status, 'active'),
        ),
      )
  if (updated) await taskChanged(tx, deps, updated, kind)
}

/**
 * Runs one due task. Lock order (docs/03 section 5.1): the person and a direct-message peer, the origin and the child
 * delegation, the destination conversation, then the task row. Every refusal ends the task as failed with a code only.
 */
export async function deliverTask(
  deps: Deps,
  kind: TaskKind,
  id: string,
): Promise<DeliveryOutcome> {
  const table = tableOf(kind)
  const [peek] = (await deps.db.select().from(table).where(eq(table.id, id))) as TaskRow[]
  if (peek?.status !== 'scheduled') return 'skipped'
  const target = 'sendAt' in peek ? peek.conversationId : null
  const peer = target ? await directPeerOf(deps.db, peek.userId, target) : null
  const [bot] = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.username, deps.config.product.agentUsername), eq(users.isBot, true)))
  return await inTransaction(deps.db, async (tx) => {
    const locked = await lockUsers(tx, [peek.userId, ...(peer ? [peer] : [])])
    const user = locked.find((u) => u.id === peek.userId)
    const [delegationRef] = peek.delegationId
      ? await tx
          .select({ originId: executionDelegations.originId })
          .from(executionDelegations)
          .where(eq(executionDelegations.id, peek.delegationId))
      : []
    const [origin] = delegationRef
      ? await tx
          .select()
          .from(authorizationOrigins)
          .where(eq(authorizationOrigins.id, delegationRef.originId))
          .for('update')
      : []
    const [delegation] = peek.delegationId
      ? await tx
          .select()
          .from(executionDelegations)
          .where(eq(executionDelegations.id, peek.delegationId))
          .for('update')
      : []
    // The destination before the task row: a scheduled message's conversation, or an existing reminder conversation.
    if (target)
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, target))
        .for('update')
    else
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(
          and(eq(conversations.ownerId, peek.userId), eq(conversations.agentPurpose, 'reminders')),
        )
        .for('update')
    const [row] = (await tx.select().from(table).where(eq(table.id, id)).for('update')) as TaskRow[]
    if (row?.status !== 'scheduled') return 'skipped'
    const now = deps.clock.now()
    if (now.getTime() > dueOf(row).getTime() + TASK_LIMITS.graceMs) {
      await finishTask(tx, deps, kind, row, { status: 'failed', code: 'OVERDUE' })
      return 'failed'
    }
    const authorized =
      user &&
      accountAllowsSession(user, now) &&
      origin &&
      !origin.revokedAt &&
      origin.userId === user.id &&
      origin.restoreEpoch === deps.config.auth.restoreEpoch &&
      delegation &&
      delegation.userId === user.id &&
      delegation.status === 'active' &&
      delegation.purpose === kind &&
      delegation.targetId === row.id &&
      delegation.authEpoch === user.authEpoch &&
      delegation.restoreEpoch === deps.config.auth.restoreEpoch &&
      delegation.expiresAt > now
    if (!authorized || !user) {
      await finishTask(tx, deps, kind, row, { status: 'failed', code: 'UNAUTHENTICATED' })
      return 'failed'
    }
    if ('sendAt' in row) {
      if (!row.conversationId || !row.body) {
        await finishTask(tx, deps, kind, row, { status: 'failed', code: 'NOT_FOUND' })
        return 'failed'
      }
      const conversationId = row.conversationId
      const body = row.body
      try {
        // A savepoint: a refusal rolls back the attempted write but the failure itself still commits.
        const written = await tx.transaction(
          async (inner) =>
            await writeMessage(
              inner,
              deps,
              { userId: user.id, role: user.role },
              conversationId,
              { clientId: uuidV5(`scheduled:${row.id}`), body },
              {
                executionSource: 'scheduled',
                meta: row.createdByRunId ? { viaAgent: { runId: row.createdByRunId } } : {},
              },
            ),
        )
        await finishTask(tx, deps, kind, row, { status: 'sent', messageId: written.row.id })
        return 'sent'
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        await finishTask(tx, deps, kind, row, { status: 'failed', code: error.code })
        return 'failed'
      }
    }
    if (!bot || !('remindAt' in row) || !row.text) {
      await finishTask(tx, deps, kind, row, { status: 'failed', code: 'CAPACITY_UNAVAILABLE' })
      return 'failed'
    }
    const conversationId = await remindersConversation(tx, deps, user.id)
    const counters = await allocateMessageSeq(tx, deps, conversationId)
    const messageId = deps.newId()
    await tx.insert(messages).values({
      id: messageId,
      conversationId,
      ...counters,
      senderId: bot.id,
      kind: 'agent',
      status: 'sent',
      body: row.text,
      executionSource: 'scheduled',
      privacyClass: row.privacyClass,
      meta: { reminder: { reminderId: row.id } },
      createdAt: now,
    })
    await recordMessageChange(tx, deps, {
      conversationId,
      messageId,
      changeSeq: counters.changeSeq,
      kind: 'message_created',
    })
    await finishTask(tx, deps, kind, row, { status: 'sent', messageId })
    return 'sent'
  })
}

// ───────── maintenance ─────────

/**
 * Due tasks whose delivery intent is gone (dead, lost or finished without an outcome) get a new one; tasks more than the
 * grace period late fail without sending. Runs every minute from Postgres, independent of the queue.
 */
export async function reconcileTasks(deps: Deps): Promise<number> {
  const now = deps.clock.now()
  let count = 0
  for (const kind of ['reminder', 'scheduled_message'] as const) {
    const table = tableOf(kind)
    const due = table === reminders ? reminders.remindAt : scheduledMessages.sendAt
    const rows = (await deps.db
      .select()
      .from(table)
      .where(and(eq(table.status, 'scheduled'), lte(due, now)))
      .limit(500)) as TaskRow[]
    for (const row of rows) {
      if (now.getTime() > dueOf(row).getTime() + TASK_LIMITS.graceMs) {
        await deliverTask(deps, kind, row.id)
        count += 1
        continue
      }
      const [live] = await deps.db
        .select({ id: workItems.id })
        .from(workItems)
        .where(
          and(
            eq(workItems.kind, 'scheduled'),
            eq(workItems.entityId, row.id),
            inArray(workItems.status, ['pending', 'leased', 'running', 'retry']),
          ),
        )
        .limit(1)
      if (live) continue
      await enqueueDelivery(
        deps.db,
        deps,
        kind,
        row.id,
        now,
        String(Math.floor(now.getTime() / 60_000)),
      )
      count += 1
    }
  }
  return count
}

/** Content of tasks that ended stays 30 days for the person's list, then only ids, state and codes remain (docs/04). */
export async function purgeTaskContent(deps: Deps): Promise<number> {
  const now = deps.clock.now()
  const cutoff = new Date(now.getTime() - TASK_LIMITS.contentRetentionMs)
  const a = await deps.db
    .update(reminders)
    .set({ text: null, contentPurgedAt: now })
    .where(
      and(
        inArray(reminders.status, ['sent', 'failed', 'cancelled']),
        lt(reminders.finishedAt, cutoff),
        isNotNull(reminders.text),
      ),
    )
    .returning({ id: reminders.id })
  const b = await deps.db
    .update(scheduledMessages)
    .set({ body: null, contentPurgedAt: now })
    .where(
      and(
        inArray(scheduledMessages.status, ['sent', 'failed', 'cancelled']),
        lt(scheduledMessages.finishedAt, cutoff),
        isNotNull(scheduledMessages.body),
      ),
    )
    .returning({ id: scheduledMessages.id })
  return a.length + b.length
}
