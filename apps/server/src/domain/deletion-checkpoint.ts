/** GC cannot race either an accepted deletion or a backup which has not yet published its remote manifest. */
import type { BackupManifest } from '@chatapp/contracts'
import { deletionJournalState, deletionOperations } from '@chatapp/db'
import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { type EncryptedDeletionJournal, JOURNAL_GENESIS } from './deletion-journal.ts'
import type { Deps } from './deps.ts'

export async function checkpointDeletionJournal(
  deps: Deps,
  journal: EncryptedDeletionJournal,
  readVerifiedInventory: () => Promise<{ snapshotId: string; manifest: BackupManifest }[]>,
) {
  return await deps.db.transaction(async (guard) => {
    const [catalogLock] = await guard.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('chatapp.backup.catalog')) as acquired`,
    )
    if (!catalogLock?.acquired) throw new Error('backup catalog is busy')
    await guard.execute(sql`set local idle_in_transaction_session_timeout = 0`)
    // Hashing large remote snapshots can take time. New deletions continue throughout that read-only phase.
    const inventory = await readVerifiedInventory()
    const [writerLock] = await guard.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('chatapp.deletion.dispatch')) as acquired`,
    )
    if (!writerLock?.acquired) throw new Error('deletion writer is busy')
    const cutoff = new Date(deps.clock.now().getTime() - 34 * 86_400_000)
    const [oldPending] = await guard
      .select({ id: deletionOperations.id })
      .from(deletionOperations)
      .where(
        and(
          inArray(deletionOperations.status, ['prepared', 'journaled']),
          lte(deletionOperations.createdAt, cutoff),
        ),
      )
      .limit(1)
    if (oldPending)
      throw new Error('old pending deletion must be reconciled before journal truncation')
    // This port must enumerate and restore/hash every snapshot in the encrypted offsite repository, including old extras.
    const [watermark] = await guard
      .select()
      .from(deletionJournalState)
      .where(eq(deletionJournalState.id, 1))
    return await journal.checkpoint(
      { seq: watermark?.appliedSeq ?? 0, hash: watermark?.appliedHash ?? JOURNAL_GENESIS },
      inventory,
    )
  })
}
