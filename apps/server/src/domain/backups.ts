/** Snapshot truth and the leased physical-delete barrier; filesystem, pg_dump and restic live behind ports. */
import { type BackupManifest, type BackupObject, backupManifestSchema } from '@chatapp/contracts'
import {
  attachmentObjects,
  attachments,
  backupRuns,
  deletionJournalState,
  type Tx,
} from '@chatapp/db'
import { and, eq, gt, sql } from 'drizzle-orm'
import { JOURNAL_GENESIS } from './deletion-journal.ts'
import type { Deps } from './deps.ts'

const physicalLock = sql`hashtext('chatapp.backup.physical-delete')`
export class BackupError extends Error {
  constructor(readonly stage: string) {
    super('consistent backup failed')
  }
}
export type BackupIO = {
  applicationSha: string
  applicationSourceHash?: string
  keyVersions: number[]
  recoveryFiles: BackupManifest['recoveryFiles']
  exportDatabase(snapshot: string): Promise<BackupManifest['database']>
  copyObject(object: BackupObject): Promise<void>
  uploadAndVerify(manifest: BackupManifest): Promise<{ manifestKey: string; manifestHash: string }>
}

/** Holds a shared database lock across the actual DELETE. Starting a backup waits for every in-flight delete. */
export async function withPhysicalDeletion(
  deps: Pick<Deps, 'db'>,
  remove: () => Promise<void>,
): Promise<boolean> {
  return await deps.db.transaction(async (tx) => {
    await tx.execute(sql`set local idle_in_transaction_session_timeout = 0`)
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${physicalLock})`)
    const barrier = await tx
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(
        and(eq(backupRuns.status, 'copying'), gt(backupRuns.leaseUntil, sql`clock_timestamp()`)),
      )
      .limit(1)
    if (barrier[0]) return false
    await remove()
    return true
  })
}

async function validLease(tx: Tx, id: string, epoch: string): Promise<void> {
  const [row] = await tx
    .select({ id: backupRuns.id })
    .from(backupRuns)
    .where(
      and(
        eq(backupRuns.id, id),
        eq(backupRuns.epoch, epoch),
        eq(backupRuns.status, 'copying'),
        gt(backupRuns.leaseUntil, sql`clock_timestamp()`),
      ),
    )
  if (!row) throw new Error('backup lease unavailable')
}

export async function createConsistentBackup(deps: Deps, io: BackupIO): Promise<BackupManifest> {
  return await deps.db.transaction(async (guard) => {
    const [lock] = await guard.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('chatapp.backup.catalog')) as acquired`,
    )
    if (!lock?.acquired) throw new BackupError('backup-catalog-busy')
    await guard.execute(sql`set local idle_in_transaction_session_timeout = 0`)
    return await backupUnderCatalogLock(deps, io)
  })
}

async function backupUnderCatalogLock(deps: Deps, io: BackupIO): Promise<BackupManifest> {
  let stage = 'snapshot-metadata'
  const id = deps.newId(),
    epoch = deps.newId(),
    startedAt = deps.clock.now()
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${physicalLock})`)
    const [active] = await tx
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .where(
        and(eq(backupRuns.status, 'copying'), gt(backupRuns.leaseUntil, sql`clock_timestamp()`)),
      )
      .limit(1)
    if (active) throw new Error('backup already copying')
    await tx.insert(backupRuns).values({
      id,
      epoch,
      status: 'copying',
      startedAt,
      leaseUntil: new Date(startedAt.getTime() + 2 * 60 * 60 * 1000),
    })
  })
  try {
    const manifest = await deps.db.transaction(
      async (tx) => {
        await tx.execute(sql`set local idle_in_transaction_session_timeout = 0`)
        const [snapshot] = await tx.execute<{ snapshot: string; at: Date | string }>(
          sql`select pg_export_snapshot() as snapshot, transaction_timestamp() as at`,
        )
        if (!snapshot || !/^[0-9A-F-]+$/.test(snapshot.snapshot))
          throw new Error('snapshot export unavailable')
        const [watermark] = await tx
          .select()
          .from(deletionJournalState)
          .where(eq(deletionJournalState.id, 1))
        const [schema] = await tx.execute<{ hash: string }>(
          sql`select hash from drizzle.__drizzle_migrations order by id desc limit 1`,
        )
        if (!schema) throw new Error('migration head unavailable')
        const rows = await tx
          .select()
          .from(attachmentObjects)
          .where(eq(attachmentObjects.status, 'live'))
        const objects = rows.map((row) => ({
          key: row.storageKey,
          size: row.sizeBytes,
          sha256: row.sha256,
        }))
        // Every ready object referenced by this snapshot must have a matching live immutable ledger entry.
        const ready = await tx
          .select({ key: attachments.storageKey, variants: attachments.variants })
          .from(attachments)
          .where(eq(attachments.status, 'ready'))
        const keys = new Set(objects.map((object) => object.key))
        if (
          ready.some(
            (row) =>
              !row.key ||
              !keys.has(row.key) ||
              Object.values(row.variants).some((variant) => !keys.has(variant.key)),
          )
        )
          throw new Error('backup reference missing from object ledger')
        stage = 'database-export'
        const database = await io.exportDatabase(snapshot.snapshot)
        stage = 'manifest-validation'
        const result = backupManifestSchema.parse({
          format: 1,
          runId: id,
          epoch,
          applicationSha: io.applicationSha,
          ...(io.applicationSourceHash ? { applicationSourceHash: io.applicationSourceHash } : {}),
          schemaHash: schema.hash,
          snapshotAt: new Date(snapshot.at).toISOString(),
          journal: {
            seq: watermark?.appliedSeq ?? 0,
            hash: watermark?.appliedHash ?? JOURNAL_GENESIS,
          },
          database,
          objects,
          keyVersions: io.keyVersions,
          recoveryFiles: io.recoveryFiles,
        })
        for (const object of result.objects) {
          stage = 'lease-and-object-copy'
          // Read the lease through a fresh transaction: a frozen repeatable-read view cannot detect lease loss.
          await deps.db.transaction((fresh) => validLease(fresh, id, epoch))
          await io.copyObject(object)
        }
        await deps.db.transaction((fresh) => validLease(fresh, id, epoch))
        return result
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
    await deps.db.transaction(async (tx) => {
      await validLease(tx, id, epoch)
      await tx
        .update(backupRuns)
        .set({
          status: 'uploading',
          snapshotAt: new Date(manifest.snapshotAt),
          objectCount: manifest.objects.length,
          journalAppliedSeq: manifest.journal.seq,
          journalAppliedHash: manifest.journal.hash,
        })
        .where(and(eq(backupRuns.id, id), eq(backupRuns.epoch, epoch)))
    })
    stage = 'restic-upload-and-readback'
    const verified = await io.uploadAndVerify(manifest)
    await deps.db
      .update(backupRuns)
      .set({ status: 'succeeded', ...verified, offsiteVerifiedAt: deps.clock.now() })
      .where(
        and(eq(backupRuns.id, id), eq(backupRuns.epoch, epoch), eq(backupRuns.status, 'uploading')),
      )
    return manifest
  } catch {
    await deps.db
      .update(backupRuns)
      .set({ status: 'failed', lastError: 'copy_or_offsite_verification_failed' })
      .where(and(eq(backupRuns.id, id), eq(backupRuns.epoch, epoch)))
    throw new BackupError(stage)
  }
}
