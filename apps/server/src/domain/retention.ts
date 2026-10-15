/** Rule v1 has a frozen evaluation time. Recovery also evaluates this rule at current time before opening data. */
import {
  agentApprovals,
  agentConversationState,
  agentRunStates,
  agentRuns,
  agentSteps,
  attachments,
  deletionOperations,
  reminders,
  reports,
  scheduledMessages,
  type Tx,
  uploadReservations,
  users,
} from '@chatapp/db'
import { and, eq, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm'
import { closePendingApprovals } from './agent-access.ts'
import { expiredAttachmentWhere, lockStorage } from './attachment-common.ts'
import { prepareDeletion } from './deletion-operations.ts'
import type { Deps } from './deps.ts'
import { lockUsers } from './sessions.ts'
import { readSitePolicy } from './site-policy.ts'
import { retireAttachment } from './uploads.ts'

const DAY = 86_400_000
export async function prepareRetention(deps: Deps): Promise<void> {
  if (!deps.deletionJournal) throw new Error('journal retention requires an offsite journal')
  // One stable operation per cleanup interval, including after a restart.
  const cutoff = new Date(Math.floor(deps.clock.now().getTime() / 600_000) * 600_000).toISOString()
  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.retention.prepare'))`)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.deletion.prepare'))`)
    const [pending] = await tx
      .select({ id: deletionOperations.id })
      .from(deletionOperations)
      .where(and(inArray(deletionOperations.status, ['prepared', 'journaled'])))
      .limit(1)
    if (pending) return
    const { policy } = await readSitePolicy(deps, tx)
    await prepareDeletion(tx, deps, null, {
      action: 'retention',
      target: { cutoff, ruleVersion: 2, runContentDays: policy.runContentDays },
    })
  })
}

export async function applyRetention(
  tx: Tx,
  deps: Deps,
  cutoff: Date,
  runContentDays = 30,
): Promise<void> {
  if (
    !Number.isFinite(cutoff.getTime()) ||
    cutoff > deps.clock.now() ||
    !Number.isInteger(runContentDays) ||
    runContentDays < 1 ||
    runContentDays > 30
  )
    throw new Error('invalid retention cutoff')
  const owners = await tx.select({ id: users.id }).from(users)
  await lockUsers(
    tx,
    owners.map((owner) => owner.id),
  )
  const runs = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        isNull(agentRuns.contentPurgedAt),
        lt(agentRuns.createdAt, new Date(cutoff.getTime() - runContentDays * DAY)),
      ),
    )
  for (let offset = 0; offset < runs.length; offset += 500) {
    const ids = runs.slice(offset, offset + 500).map((run) => run.id)
    await tx
      .update(agentRuns)
      .set({
        status: 'failed',
        finishedAt: deps.clock.now(),
        leaseEpoch: sql`${agentRuns.leaseEpoch}+1`,
        leaseUntil: null,
        stateVersion: sql`${agentRuns.stateVersion}+1`,
        pendingApproval: false,
        errorCode: 'CONTENT_EXPIRED',
        errorMessage: null,
      })
      .where(
        and(
          inArray(agentRuns.id, ids),
          inArray(agentRuns.status, ['queued', 'running', 'awaiting_approval']),
        ),
      )
    await closePendingApprovals(tx, deps, ids, 'expired')
    await tx
      .update(agentRunStates)
      .set({ messages: [], updatedAt: deps.clock.now() })
      .where(inArray(agentRunStates.runId, ids))
    await tx.update(agentSteps).set({ payload: null }).where(inArray(agentSteps.runId, ids))
    await tx
      .update(agentApprovals)
      .set({ args: null, editedArgs: null, finalArgs: null })
      .where(inArray(agentApprovals.runId, ids))
    await tx
      .update(agentRuns)
      .set({ contextManifest: [], contentPurgedAt: deps.clock.now() })
      .where(inArray(agentRuns.id, ids))
  }
  const taskCutoff = new Date(cutoff.getTime() - runContentDays * DAY)
  await tx
    .update(reports)
    .set({ details: null, resolutionNote: null })
    .where(lt(reports.createdAt, taskCutoff))
  await tx
    .update(reminders)
    .set({ text: null, contentPurgedAt: deps.clock.now() })
    .where(
      and(
        inArray(reminders.status, ['sent', 'failed', 'cancelled']),
        lt(reminders.finishedAt, taskCutoff),
        isNotNull(reminders.text),
      ),
    )
  await tx
    .update(scheduledMessages)
    .set({ body: null, contentPurgedAt: deps.clock.now() })
    .where(
      and(
        inArray(scheduledMessages.status, ['sent', 'failed', 'cancelled']),
        lt(scheduledMessages.finishedAt, taskCutoff),
        isNotNull(scheduledMessages.body),
      ),
    )
  await tx.delete(agentConversationState).where(lte(agentConversationState.expiresAt, cutoff))
  const expired = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .innerJoin(uploadReservations, eq(uploadReservations.attachmentId, attachments.id))
    .where(expiredAttachmentWhere(tx, cutoff))
    .orderBy(attachments.id)
  if (expired.length) {
    await lockStorage(tx)
    for (const file of expired)
      if (await retireAttachment(tx, deps, file.id))
        throw new Error('accepted retention attachment unexpectedly prepared again')
  }
}
