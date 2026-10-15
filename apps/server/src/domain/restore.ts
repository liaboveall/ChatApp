/** Recovery remains isolated until deletion evidence AND separately reconfirmed permissions are complete (D-071). */
import type { BackupManifest } from '@chatapp/contracts'
import {
  accounts,
  appSettings,
  authChallenges,
  authorizationOrigins,
  backupRuns,
  type Db,
  deletionJournalState,
  deletionLocks,
  deletionOperations,
  executionDelegations,
  passkeys,
  pushSubscriptions,
  reminders,
  scheduledMessages,
  sessions,
  userAiKeys,
  users,
  verifications,
  workItems,
} from '@chatapp/db'
import { eq, inArray, sql } from 'drizzle-orm'
import { applyDeletion } from './deletion-apply.ts'
import { deletionFingerprint, type EncryptedDeletionJournal } from './deletion-journal.ts'
import { advanceAppliedWatermark, deletionTargetKey } from './deletion-operations.ts'
import type { Deps } from './deps.ts'
import { applyRetention } from './retention.ts'
import { lockUsers } from './sessions.ts'
import { readSitePolicy } from './site-policy.ts'

export async function assertRestoreUnlocked(db: Db): Promise<void> {
  const [state] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, 'restore_state'))
  if (state)
    throw new Error(
      'restored dataset remains isolated pending evidence and permission reconfirmation',
    )
}

/** Call before any API, worker or object cleanup can observe the restored database. No external effects are emitted. */
export async function isolateRestoredDatabase(deps: Deps, epoch: string): Promise<void> {
  if (!/^[a-f0-9-]{36}$/.test(epoch)) throw new Error('invalid restore epoch')
  await deps.db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('chatapp.deletion.dispatch')) as acquired`,
    )
    if (!lock?.acquired) throw new Error('deletion writer or another restore is running')
    const [existing] = await tx
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'restore_state'))
      .for('update')
    if (existing) {
      if (
        existing.value &&
        typeof existing.value === 'object' &&
        'epoch' in existing.value &&
        existing.value.epoch === epoch &&
        'mode' in existing.value &&
        existing.value.mode === 'isolated'
      )
        return
      throw new Error('restore isolation epoch changed; existing evidence is preserved')
    }
    await lockUsers(
      tx,
      (await tx.select({ id: users.id }).from(users)).map((user) => user.id),
    )
    await tx.insert(appSettings).values({
      key: 'restore_state',
      value: { mode: 'isolated', epoch, permissions: 'pending', journal: 'pending' },
    })
    // The SQL child guard permits only credential revocation and cancelled/uncertain tasks in this durable isolation.
    await tx.execute(sql`select set_config('chatapp.restore_isolation', ${epoch}, true)`)
    await tx
      .update(backupRuns)
      .set({
        status: 'failed',
        leaseUntil: sql`least(${backupRuns.leaseUntil}, clock_timestamp())`,
        lastError: 'restore_invalidated_source_lease',
      })
      .where(inArray(backupRuns.status, ['copying', 'uploading']))
    await tx.delete(sessions)
    await tx.delete(verifications)
    await tx.delete(authChallenges)
    await tx.delete(pushSubscriptions)
    await tx
      .update(authorizationOrigins)
      .set({ revokedAt: deps.clock.now(), revokeReason: 'restore' })
    await tx.update(executionDelegations).set({ status: 'revoked', revokedAt: deps.clock.now() })
    // Old passwords, passkeys and BYOK secrets never regain authority merely because a snapshot contained them.
    await tx
      .update(accounts)
      .set({ password: null, accessToken: null, refreshToken: null, idToken: null })
    await tx.delete(passkeys)
    await tx.delete(userAiKeys)
    await tx
      .update(reminders)
      .set({
        status: 'cancelled',
        text: null,
        finishedAt: deps.clock.now(),
        contentPurgedAt: deps.clock.now(),
        version: sql`${reminders.version}+1`,
      })
      .where(eq(reminders.status, 'scheduled'))
    await tx
      .update(scheduledMessages)
      .set({
        status: 'cancelled',
        body: null,
        finishedAt: deps.clock.now(),
        contentPurgedAt: deps.clock.now(),
        version: sql`${scheduledMessages.version}+1`,
      })
      .where(eq(scheduledMessages.status, 'scheduled'))
    // Pending API work will not be redelivered before an explicit recovery decision.
    await tx
      .update(workItems)
      .set({
        status: 'uncertain',
        leaseEpoch: sql`${workItems.leaseEpoch}+1`,
        leaseUntil: null,
        finishedAt: deps.clock.now(),
        lastErrorCode: 'RESTORE_ISOLATED',
      })
      .where(inArray(workItems.status, ['pending', 'retry', 'leased', 'running']))
  })
}

/** Replays also accepted records missing from the source snapshot. Never appends new journal records during recovery. */
export async function replayDeletionJournal(
  deps: Deps,
  journal: EncryptedDeletionJournal,
  manifest: BackupManifest,
  epoch: string,
): Promise<{ seq: number; hash: string; replayed: number }> {
  return await deps.db.transaction(async (guard) => {
    const [lock] = await guard.execute<{ acquired: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtext('chatapp.deletion.dispatch')) as acquired`,
    )
    if (!lock?.acquired) throw new Error('deletion writer or another restore is running')
    await guard.execute(sql`set local idle_in_transaction_session_timeout = 0`)
    return await replayInIsolation(deps, journal, manifest, epoch)
  })
}

async function replayInIsolation(
  deps: Deps,
  journal: EncryptedDeletionJournal,
  manifest: BackupManifest,
  epoch: string,
): Promise<{ seq: number; hash: string; replayed: number }> {
  const [fence] = await deps.db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, 'restore_state'))
  if (
    !fence ||
    typeof fence.value !== 'object' ||
    fence.value === null ||
    !('epoch' in fence.value) ||
    fence.value.epoch !== epoch
  )
    throw new Error('restore isolation fence missing')
  const [snapshotState] = await deps.db.select().from(deletionJournalState)
  const manifestHash = deletionFingerprint(manifest)
  const previousManifest = 'replayManifest' in fence.value ? fence.value.replayManifest : undefined
  if (previousManifest !== undefined && previousManifest !== manifestHash)
    throw new Error('resume manifest changed; remain isolated')
  const current = {
    seq: snapshotState?.appliedSeq ?? 0,
    hash: snapshotState?.appliedHash ?? '0'.repeat(64),
  }
  if (
    previousManifest === undefined &&
    (current.seq !== manifest.journal.seq || current.hash !== manifest.journal.hash)
  )
    throw new Error('manifest does not match restored deletion watermark')
  // Validate the complete suffix first. A corrupt late record must not result in a partially approved dataset.
  const accepted = await journal.readSince(manifest.journal)
  const resumedAnchor =
    current.seq === manifest.journal.seq
      ? manifest.journal
      : accepted.find((entry) => entry.record.seq === current.seq)
  if (current.seq < manifest.journal.seq || !resumedAnchor || resumedAnchor.hash !== current.hash)
    throw new Error('resumed watermark is not on the trusted chain')
  await deps.db.transaction(async (tx) => {
    const [stored] = await tx
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'restore_state'))
      .for('update')
    if (!stored || deletionFingerprint(stored.value) !== deletionFingerprint(fence.value))
      throw new Error('restore fence changed')
    await tx
      .update(appSettings)
      .set({
        value: {
          mode: 'isolated',
          epoch,
          permissions: 'pending',
          journal: 'pending',
          replayManifest: manifestHash,
        },
      })
      .where(eq(appSettings.key, 'restore_state'))
  })
  let replayed = 0
  for (const entry of accepted) {
    await deps.db
      .transaction(async (tx) => {
        const record = entry.record
        const [local] = await tx
          .select()
          .from(deletionOperations)
          .where(eq(deletionOperations.id, record.operationId))
          .for('update')
        const requestHash = deletionFingerprint({ actorId: record.actorId, intent: record.intent })
        if (local && local.requestHash !== requestHash)
          throw new Error('restored operation conflicts with accepted intent')
        if (
          local?.status === 'applied' &&
          (local.journalSeq !== record.seq ||
            local.journalHash !== entry.hash ||
            local.journalEpoch !== record.writerEpoch)
        )
          throw new Error('restored applied operation conflicts with accepted journal')
        if (record.seq <= current.seq && local?.status !== 'applied')
          throw new Error('resumed applied operation is missing')
        const [actor] = record.actorId
          ? await tx.select({ id: users.id }).from(users).where(eq(users.id, record.actorId))
          : []
        if (!local)
          await tx.insert(deletionOperations).values({
            id: record.operationId,
            actorId: actor?.id ?? null,
            action: record.intent.action,
            targetKey: deletionTargetKey(record.intent),
            intent: record.intent,
            requestHash,
            status: 'journaled',
            journalEpoch: record.writerEpoch,
            journalSeq: record.seq,
            journalHash: entry.hash,
            createdAt: new Date(record.acceptedAt),
          })
        else if (local.status !== 'applied')
          await tx
            .update(deletionOperations)
            .set({
              status: 'journaled',
              journalEpoch: record.writerEpoch,
              journalSeq: record.seq,
              journalHash: entry.hash,
            })
            .where(eq(deletionOperations.id, local.id))
        await tx.execute(
          sql`select set_config('chatapp.deletion_operation', ${record.operationId}, true)`,
        )
        if (local?.status !== 'applied') {
          await applyDeletion(tx, deps, record.intent, actor?.id ?? null)
          await tx
            .update(deletionOperations)
            .set({
              status: 'applied',
              appliedAt: deps.clock.now(),
              version: sql`${deletionOperations.version}+1`,
            })
            .where(eq(deletionOperations.id, record.operationId))
          await tx.delete(deletionLocks).where(eq(deletionLocks.operationId, record.operationId))
        }
        await advanceAppliedWatermark(tx, deps)
        return local?.status !== 'applied'
      })
      .then((applied) => {
        if (applied) replayed++
      })
  }
  const head = (await journal.head()).head
  const [state] = await deps.db.select().from(deletionJournalState)
  if ((state?.appliedSeq ?? 0) !== head.seq || (state?.appliedHash ?? '0'.repeat(64)) !== head.hash)
    throw new Error('journal changed or replay has a gap; remain isolated')
  // This fixed current rule is allowed in isolation even without an accepted batch: expired plaintext cannot reopen.
  await deps.db.transaction(async (tx) => {
    const { policy } = await readSitePolicy(deps, tx)
    await applyRetention(tx, deps, deps.clock.now(), policy.runContentDays)
  })
  const currentHead = (await journal.head()).head
  if (
    currentHead.seq !== head.seq ||
    currentHead.hash !== head.hash ||
    currentHead.writerEpoch !== head.writerEpoch
  )
    throw new Error('journal changed during retention; remain isolated')
  await deps.db
    .update(appSettings)
    .set({
      value: {
        mode: 'isolated',
        epoch,
        permissions: 'pending',
        journal: 'verified',
        seq: head.seq,
        hash: head.hash,
        replayManifest: manifestHash,
      },
    })
    .where(eq(appSettings.key, 'restore_state'))
  return { seq: head.seq, hash: head.hash, replayed }
}
