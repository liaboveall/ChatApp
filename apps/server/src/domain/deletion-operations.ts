/** Durable preparation, frozen targets, irreversible offsite acceptance, and contiguous applied watermark (D-084). */
import {
  AppError,
  type DeletionIntent,
  type DeletionOperation,
  deletionIntentSchema,
} from '@chatapp/contracts'
import { deletionJournalState, deletionLocks, deletionOperations, type Tx } from '@chatapp/db'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { deletionFingerprint } from './deletion-journal.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate } from './sessions.ts'

type Row = typeof deletionOperations.$inferSelect
type TargetType = typeof deletionLocks.$inferInsert.targetType
const targetType = (intent: DeletionIntent): TargetType | null => {
  switch (intent.action) {
    case 'message_recall':
    case 'message_delete':
      return 'message'
    case 'memory_delete':
      return 'memory'
    case 'agent_conversation_delete':
      return 'conversation'
    case 'attachment_delete':
      return 'attachment'
    case 'account_delete':
      return 'user'
    case 'retention':
      return null
  }
}
export const deletionTargetKey = (intent: DeletionIntent) =>
  'id' in intent.target
    ? intent.target.id
    : intent.target.ruleVersion === 2
      ? `${intent.target.cutoff}:v2:${intent.target.runContentDays}`
      : intent.target.cutoff
export const operationDto = (row: Row): DeletionOperation => ({
  operationId: row.id,
  status: row.status === 'applied' ? 'completed' : row.status === 'failed' ? 'failed' : 'pending',
  statusUrl: `/api/deletion-operations/${row.id}`,
  version: row.version,
  errorCode: row.status === 'failed' ? 'permanent_failure' : null,
})

export async function findDeletion(
  tx: Tx,
  actorId: string,
  action: DeletionIntent['action'],
  key: string,
): Promise<Row | undefined> {
  return (
    await tx
      .select()
      .from(deletionOperations)
      .where(
        and(
          eq(deletionOperations.actorId, actorId),
          eq(deletionOperations.action, action),
          eq(deletionOperations.targetKey, key),
        ),
      )
      .limit(1)
  )[0]
}

/** Must be called only inside the entry point's authorized target-locking transaction. */
export async function prepareDeletion(
  tx: Tx,
  deps: Deps,
  actorId: string | null,
  input: DeletionIntent,
): Promise<Row> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.deletion.prepare'))`)
  const intent = deletionIntentSchema.parse(input)
  const key = deletionTargetKey(intent)
  const existing = await tx
    .select()
    .from(deletionOperations)
    .where(
      and(
        actorId === null
          ? sql`${deletionOperations.actorId} is null`
          : eq(deletionOperations.actorId, actorId),
        eq(deletionOperations.action, intent.action),
        eq(deletionOperations.targetKey, key),
      ),
    )
    .limit(1)
  if (existing[0]) return existing[0]
  const broad = ['account_delete', 'agent_conversation_delete', 'retention'].includes(intent.action)
  const [overlap] = await tx
    .select({ id: deletionOperations.id })
    .from(deletionOperations)
    .where(
      and(
        inArray(deletionOperations.status, ['prepared', 'journaled']),
        broad
          ? undefined
          : inArray(deletionOperations.action, [
              'account_delete',
              'agent_conversation_delete',
              'retention',
            ]),
      ),
    )
    .limit(1)
  // Source invalidation can touch private runs of other users. Broad freezes cannot overlap unfinished intentions
  // whose application they block, including a 202 handler dispatching only its own newly prepared operation.
  if (overlap)
    throw new AppError('VERSION_CONFLICT', 'Another deletion must settle first', {
      details: { reason: 'deletion_busy' },
    })
  const type = targetType(intent)
  if (type) await assertDeletionMutable(tx, type, key)
  const [row] = await tx
    .insert(deletionOperations)
    .values({
      id: deps.newId(),
      actorId,
      action: intent.action,
      targetKey: key,
      intent,
      requestHash: deletionFingerprint({ actorId, intent }),
      status: 'prepared',
      createdAt: deps.clock.now(),
    })
    .returning()
  if (!row) throw new Error('deletion preparation failed')
  if (type)
    await tx.insert(deletionLocks).values({ targetType: type, targetId: key, operationId: row.id })
  return row
}

export async function assertDeletionMutable(tx: Tx, type: TargetType, id: string): Promise<void> {
  const lock = await tx
    .select({ id: deletionLocks.operationId })
    .from(deletionLocks)
    .where(and(eq(deletionLocks.targetType, type), eq(deletionLocks.targetId, id)))
    .limit(1)
  if (lock[0])
    throw new AppError('VERSION_CONFLICT', 'Deletion is pending', {
      details: { reason: 'deletion_pending' },
    })
}

export async function getDeletionOperation(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<DeletionOperation> {
  return await deps.db.transaction(async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const [row] = await tx
      .select()
      .from(deletionOperations)
      .where(and(eq(deletionOperations.id, id), eq(deletionOperations.actorId, principal.userId)))
    if (!row) throw new AppError('NOT_FOUND', 'Deletion operation not found')
    return operationDto(row)
  })
}

export type ApplyDeletion = (
  tx: Tx,
  deps: Deps,
  intent: DeletionIntent,
  actorId: string | null,
) => Promise<void>

/** Scans independently of queues. Business transactions never hold a target lock while waiting for object storage. */
export async function dispatchDeletions(
  deps: Deps,
  apply: ApplyDeletion,
  onlyId?: string,
): Promise<number> {
  if (!deps.deletionJournal) return 0
  return await deps.db.transaction(async (guard) => {
    const result = await guard.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('chatapp.deletion.dispatch')) as acquired`,
    )
    if (!result[0]?.acquired) return 0
    await guard.execute(sql`set local idle_in_transaction_session_timeout = 0`)
    const rows = await deps.db
      .select()
      .from(deletionOperations)
      .where(
        and(
          inArray(deletionOperations.status, ['prepared', 'journaled']),
          onlyId ? eq(deletionOperations.id, onlyId) : undefined,
        ),
      )
      .orderBy(asc(deletionOperations.createdAt), asc(deletionOperations.id))
      .limit(50)
    let completed = 0
    for (const row of rows) {
      try {
        if (row.status === 'prepared') {
          const accepted = await deps.deletionJournal?.append({
            operationId: row.id,
            actorId: row.actorId,
            intent: row.intent,
            acceptedAt: deps.clock.now().toISOString(),
            preparedAt: row.createdAt.toISOString(),
          })
          if (!accepted) return completed
          if (
            deletionFingerprint({
              actorId: accepted.record.actorId,
              intent: accepted.record.intent,
            }) !== row.requestHash
          )
            throw new Error('deletion acceptance mismatch')
          await deps.db
            .update(deletionOperations)
            .set({
              status: 'journaled',
              journalEpoch: accepted.record.writerEpoch,
              journalSeq: accepted.record.seq,
              journalHash: accepted.hash,
              version: sql`${deletionOperations.version} + 1`,
            })
            .where(
              and(eq(deletionOperations.id, row.id), eq(deletionOperations.status, 'prepared')),
            )
        }
        await deps.db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(deletionOperations)
            .where(eq(deletionOperations.id, row.id))
            .for('update')
          if (!current || current.status === 'applied') return
          if (current.status !== 'journaled') throw new Error('deletion not accepted')
          // SQL guards admit only the stored irreversible operation, never a caller-supplied bypass flag.
          await tx.execute(
            sql`select set_config('chatapp.deletion_operation', ${current.id}, true)`,
          )
          await apply(tx, deps, current.intent, current.actorId)
          await tx
            .update(deletionOperations)
            .set({
              status: 'applied',
              appliedAt: deps.clock.now(),
              version: sql`${deletionOperations.version} + 1`,
            })
            .where(eq(deletionOperations.id, current.id))
          await tx.delete(deletionLocks).where(eq(deletionLocks.operationId, current.id))
          await advanceAppliedWatermark(tx, deps)
        })
        completed++
      } catch {
        // Unknown network outcome never changes to failed and never unfreezes the target. The next scan reconciles.
        deps.log.warn('deletion.pending', { reason: 'offsite_or_apply_unavailable' })
        if (deps.clock.now().getTime() - row.createdAt.getTime() > 60_000)
          deps.log.error('deletion.overdue', { reason: 'pending_over_60_seconds' })
        break
      }
    }
    return completed
  })
}

export async function advanceAppliedWatermark(tx: Tx, deps: Deps): Promise<void> {
  await tx
    .insert(deletionJournalState)
    .values({ id: 1, updatedAt: deps.clock.now() })
    .onConflictDoNothing()
  const [state] = await tx
    .select()
    .from(deletionJournalState)
    .where(eq(deletionJournalState.id, 1))
    .for('update')
  if (!state) throw new Error('missing deletion watermark')
  let seq = state.appliedSeq
  let hash = state.appliedHash
  for (;;) {
    const [next] = await tx
      .select()
      .from(deletionOperations)
      .where(
        and(eq(deletionOperations.journalSeq, seq + 1), eq(deletionOperations.status, 'applied')),
      )
    if (!next?.journalHash) break
    seq++
    hash = next.journalHash
  }
  await tx
    .update(deletionJournalState)
    .set({ appliedSeq: seq, appliedHash: hash, updatedAt: deps.clock.now() })
    .where(eq(deletionJournalState.id, 1))
}

/** A pending response is still a successful preparation, never a successful deletion. */
export async function settleDeletion(
  deps: Deps,
  operationId: string,
  apply: ApplyDeletion,
): Promise<DeletionOperation> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      dispatchDeletions(deps, apply, operationId).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  const [row] = await deps.db
    .select()
    .from(deletionOperations)
    .where(eq(deletionOperations.id, operationId))
  if (!row) throw new Error('deletion operation vanished')
  return operationDto(row)
}
