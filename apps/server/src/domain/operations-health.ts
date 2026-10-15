import { operationsHealthSchema } from '@chatapp/contracts'
import {
  attachmentObjects,
  backupRuns,
  deletionJournalState,
  deletionOperations,
  workItems,
} from '@chatapp/db'
import { and, desc, eq, inArray, isNotNull, lt } from 'drizzle-orm'
import type { EncryptedDeletionJournal } from './deletion-journal.ts'
import type { Deps } from './deps.ts'
export async function operationsHealth(deps: Deps, journal: EncryptedDeletionJournal) {
  const problems: string[] = []
  const now = deps.clock.now().getTime()
  const [backup] = await deps.db
    .select()
    .from(backupRuns)
    .where(eq(backupRuns.status, 'succeeded'))
    .orderBy(desc(backupRuns.snapshotAt))
    .limit(1)
  const age = backup?.snapshotAt ? now - backup.snapshotAt.getTime() : null
  if (age !== null && age < -300_000) problems.push('backup_clock_skew')
  if (age === null || age > 20 * 3_600_000)
    problems.push(
      age === null
        ? 'backup_missing'
        : age > 24 * 3_600_000
          ? 'backup_rpo_exceeded'
          : 'backup_age_warning',
    )
  const [latest] = await deps.db
    .select()
    .from(backupRuns)
    .orderBy(desc(backupRuns.startedAt))
    .limit(1)
  if (latest?.status === 'failed') problems.push('backup_latest_failed')
  const pending = await deps.db
    .select({ id: deletionOperations.id })
    .from(deletionOperations)
    .where(
      and(
        inArray(deletionOperations.status, ['prepared', 'journaled']),
        lt(deletionOperations.createdAt, new Date(now - 60_000)),
      ),
    )
    .limit(1)
  if (pending.length) problems.push('deletion_pending_over_minute')
  const [state] = await deps.db
    .select()
    .from(deletionJournalState)
    .where(eq(deletionJournalState.id, 1))
  try {
    const head = (await journal.head()).head
    await journal.readSince({
      seq: state?.appliedSeq ?? 0,
      hash: state?.appliedHash ?? '0'.repeat(64),
    })
    if (head.seq < (state?.appliedSeq ?? 0)) problems.push('journal_watermark_ahead')
  } catch {
    problems.push('journal_integrity_or_availability')
  }
  const physical = await deps.db
    .select({ id: attachmentObjects.id })
    .from(attachmentObjects)
    .where(
      and(
        eq(attachmentObjects.status, 'deleting'),
        isNotNull(attachmentObjects.deleteAfter),
        lt(attachmentObjects.deleteAfter, new Date(now - 3_600_000)),
      ),
    )
    .limit(1)
  if (physical.length) problems.push('physical_delete_over_hour')
  const jobs = await deps.db
    .select({ id: workItems.id })
    .from(workItems)
    .where(eq(workItems.status, 'dead'))
    .limit(1)
  if (jobs.length) problems.push('dead_letters')
  if (deps.blobs) {
    try {
      const capacity = await deps.blobs.capacity()
      if (capacity.dataFreeBytes < 2 * 1024 ** 3 || capacity.metadataFreeBytes < 512 * 1024 ** 2)
        problems.push('storage_low_free_space')
    } catch {
      problems.push('storage_capacity_unavailable')
    }
  }
  return operationsHealthSchema.parse({
    status: problems.length ? 'attention' : 'healthy',
    backupAgeSeconds: age === null ? null : Math.floor(age / 1000),
    problems,
  })
}
