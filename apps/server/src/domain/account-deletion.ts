/** INV-11. Accept an identifier-only intent, then anonymize and revoke every personal capability in one transaction. */
import { AppError, type DeletionIntent, type DeletionOperation, LIMITS } from '@chatapp/contracts'
import {
  accounts,
  agentApprovals,
  agentMemories,
  agentRunStates,
  agentRuns,
  agentSteps,
  attachments,
  authChallenges,
  conversationMembers,
  conversations,
  deletionOperations,
  executionDelegations,
  notifications,
  passkeys,
  pushSubscriptions,
  registrationInvites,
  registrationInviteUses,
  reminders,
  reports,
  scheduledMessages,
  sessions,
  type Tx,
  userAiKeys,
  usernameReservations,
  users,
  verifications,
} from '@chatapp/db'
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { signPayload, verifyPayload } from '../lib/crypto.ts'
import { closePendingApprovals } from './agent-access.ts'
import { applyAgentConversationDeletion } from './agent-runs.ts'
import { lockStorage } from './attachment-common.ts'
import { writeAudit } from './audit.ts'
import { bumpConversation, recordUserChange } from './changes.ts'
import { applyDeletion } from './deletion-apply.ts'
import {
  findDeletion,
  operationDto,
  prepareDeletion,
  settleDeletion,
} from './deletion-operations.ts'
import type { Deps } from './deps.ts'
import { removeMember } from './membership.ts'
import { deleteMemoryRow } from './memories.ts'
import type { SessionPrincipal } from './principal.ts'
import { enqueueRevocationHint, lockAndRevalidate, revokeOrigins } from './sessions.ts'
import { retireAttachment } from './uploads.ts'

const receiptSchema = z
  .object({
    purpose: z.literal('account-deletion-status'),
    actorId: z.uuid(),
    operationId: z.uuid(),
    restoreEpoch: z.string(),
    expiresAt: z.number().int(),
  })
  .strict()
export function accountDeletionReceipt(deps: Deps, actorId: string, operationId: string): string {
  return signPayload(deps.config.auth.cursorKey, {
    purpose: 'account-deletion-status',
    actorId,
    operationId,
    restoreEpoch: deps.config.auth.restoreEpoch,
    expiresAt: deps.clock.now().getTime() + 10 * 60_000,
  })
}
export async function getAccountDeletionByReceipt(
  deps: Deps,
  id: string,
  token: string,
): Promise<DeletionOperation> {
  const parsed =
    token.length <= 2048
      ? receiptSchema.safeParse(verifyPayload(deps.config.auth.cursorKey, token))
      : { success: false as const }
  if (
    !parsed.success ||
    parsed.data.operationId !== id ||
    parsed.data.restoreEpoch !== deps.config.auth.restoreEpoch ||
    parsed.data.expiresAt <= deps.clock.now().getTime()
  )
    throw new AppError('NOT_FOUND', 'Deletion operation not found')
  const [row] = await deps.db
    .select()
    .from(deletionOperations)
    .where(
      and(
        eq(deletionOperations.id, id),
        eq(deletionOperations.actorId, parsed.data.actorId),
        eq(deletionOperations.action, 'account_delete'),
      ),
    )
  if (!row) throw new AppError('NOT_FOUND', 'Deletion operation not found')
  return operationDto(row)
}

export async function requestAccountDeletion(
  deps: Deps,
  principal: SessionPrincipal,
  password: string,
): Promise<DeletionOperation> {
  if (!deps.deletionJournal)
    throw new AppError('CAPACITY_UNAVAILABLE', 'Offsite deletion service unavailable')
  const operation = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.retention.prepare'))`)
    const user = await lockAndRevalidate(tx, deps, principal)
    const [credential] = await tx
      .select({ password: accounts.password })
      .from(accounts)
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, 'credential')))
    if (!credential?.password || !(await deps.passwords.verify(credential.password, password)))
      throw new AppError('FORBIDDEN', 'Password confirmation failed', {
        details: { reason: 'wrong_password' },
      })
    const existing = await findDeletion(tx, user.id, 'account_delete', user.id)
    if (existing) return existing
    return await prepareDeletion(tx, deps, user.id, {
      action: 'account_delete',
      target: { id: user.id, authEpoch: user.authEpoch },
    })
  })
  return await settleDeletion(deps, operation.id, applyDeletion)
}

export async function applyAccountDeletion(
  tx: Tx,
  deps: Deps,
  intent: Extract<DeletionIntent, { action: 'account_delete' }>,
): Promise<void> {
  await tx
    .update(reports)
    .set({ details: null, resolutionNote: null, reporterId: null })
    .where(eq(reports.reporterId, intent.target.id))
  const [user] = await tx.select().from(users).where(eq(users.id, intent.target.id)).for('update')
  if (!user || user.deletedAt) return
  if (user.isBot || user.authEpoch > intent.target.authEpoch)
    throw new Error('frozen account identity or epoch mismatch')
  const now = deps.clock.now()
  await revokeOrigins(tx, deps, user.id, { kind: 'all' }, 'account_deleted')
  await tx.delete(sessions).where(eq(sessions.userId, user.id))
  await tx
    .update(executionDelegations)
    .set({ status: 'revoked', revokedAt: now })
    .where(and(eq(executionDelegations.userId, user.id), eq(executionDelegations.status, 'active')))
  const runs = await tx
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.userId, user.id))
  const runIds = runs.map((run) => run.id)
  if (runIds.length) {
    await tx
      .update(agentRuns)
      .set({
        status: 'cancelled',
        cancelRequestedAt: now,
        finishedAt: now,
        leaseEpoch: sql`${agentRuns.leaseEpoch}+1`,
        leaseUntil: null,
        stateVersion: sql`${agentRuns.stateVersion}+1`,
        pendingApproval: false,
        errorCode: 'UNAUTHENTICATED',
        errorMessage: null,
      })
      .where(
        and(
          inArray(agentRuns.id, runIds),
          inArray(agentRuns.status, ['queued', 'running', 'awaiting_approval']),
        ),
      )
    await closePendingApprovals(tx, deps, runIds, 'cancelled')
    await tx
      .update(agentRunStates)
      .set({ messages: [], updatedAt: now })
      .where(inArray(agentRunStates.runId, runIds))
    await tx.update(agentSteps).set({ payload: null }).where(inArray(agentSteps.runId, runIds))
    await tx
      .update(agentApprovals)
      .set({ args: null, editedArgs: null, finalArgs: null })
      .where(inArray(agentApprovals.runId, runIds))
    await tx
      .update(agentRuns)
      .set({ contextManifest: [], contentPurgedAt: now })
      .where(inArray(agentRuns.id, runIds))
  }
  await tx
    .update(reminders)
    .set({
      status: 'cancelled',
      text: null,
      finishedAt: now,
      contentPurgedAt: now,
      version: sql`${reminders.version}+1`,
    })
    .where(and(eq(reminders.userId, user.id), eq(reminders.status, 'scheduled')))
  await tx
    .update(scheduledMessages)
    .set({
      status: 'cancelled',
      body: null,
      finishedAt: now,
      contentPurgedAt: now,
      version: sql`${scheduledMessages.version}+1`,
    })
    .where(and(eq(scheduledMessages.userId, user.id), eq(scheduledMessages.status, 'scheduled')))
  await tx
    .update(reminders)
    .set({ text: null, contentPurgedAt: now })
    .where(eq(reminders.userId, user.id))
  await tx
    .update(scheduledMessages)
    .set({ body: null, contentPurgedAt: now })
    .where(eq(scheduledMessages.userId, user.id))
  for (const memory of await tx
    .select({ id: agentMemories.id })
    .from(agentMemories)
    .where(eq(agentMemories.userId, user.id)))
    await deleteMemoryRow(tx, deps, user.id, memory.id)
  await tx.delete(agentMemories).where(eq(agentMemories.userId, user.id))
  for (const chat of await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.kind, 'agent'), eq(conversations.ownerId, user.id)))
    .orderBy(asc(conversations.id)))
    await applyAgentConversationDeletion(tx, deps, chat.id, user.id)
  const memberships = await tx
    .select({ member: conversationMembers, conversation: conversations })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversationMembers.conversationId, conversations.id))
    .where(
      and(
        eq(conversationMembers.userId, user.id),
        inArray(conversations.kind, ['group', 'channel']),
      ),
    )
    .orderBy(asc(conversations.id))
  for (const { member, conversation } of memberships) {
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversation.id))
      .for('update')
    if (conversation.ownerId === user.id) {
      const [successor] = await tx
        .select()
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversation.id),
            ne(conversationMembers.userId, user.id),
          ),
        )
        .orderBy(
          sql`case when ${conversationMembers.role} = 'admin' then 0 else 1 end`,
          asc(conversationMembers.joinedAt),
          asc(conversationMembers.userId),
        )
        .limit(1)
      await tx
        .update(conversationMembers)
        .set({ role: 'member' })
        .where(
          and(
            eq(conversationMembers.conversationId, conversation.id),
            eq(conversationMembers.userId, user.id),
          ),
        )
      if (successor) {
        await tx
          .update(conversationMembers)
          .set({ role: 'owner' })
          .where(
            and(
              eq(conversationMembers.conversationId, conversation.id),
              eq(conversationMembers.userId, successor.userId),
            ),
          )
        await tx
          .update(conversations)
          .set({ ownerId: successor.userId })
          .where(eq(conversations.id, conversation.id))
      } else
        await tx
          .update(conversations)
          .set({ ownerId: null, archivedAt: now })
          .where(eq(conversations.id, conversation.id))
      await bumpConversation(tx, deps, conversation.id, { metadata: true, membership: true })
    }
    await removeMember(tx, deps, conversation, member, { type: 'left' })
  }
  const retiredAvatars = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(attachments, eq(conversations.avatarAttachmentId, attachments.id))
    .where(and(eq(attachments.uploaderId, user.id), isNull(attachments.messageId)))
    .orderBy(asc(conversations.id))
  for (const avatar of retiredAvatars) {
    await tx
      .update(conversations)
      .set({ avatarAttachmentId: null })
      .where(eq(conversations.id, avatar.id))
    await bumpConversation(tx, deps, avatar.id, { metadata: true })
  }
  await lockStorage(tx)
  for (const file of await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(eq(attachments.uploaderId, user.id), isNull(attachments.messageId))))
    if (await retireAttachment(tx, deps, file.id))
      throw new Error('accepted account attachment unexpectedly prepared again')
  await tx.delete(accounts).where(eq(accounts.userId, user.id))
  await tx.delete(passkeys).where(eq(passkeys.userId, user.id))
  await tx.delete(userAiKeys).where(eq(userAiKeys.userId, user.id))
  await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id))
  await tx.delete(notifications).where(eq(notifications.userId, user.id))
  await tx.delete(authChallenges).where(eq(authChallenges.userId, user.id))
  await tx
    .delete(verifications)
    .where(
      or(
        eq(verifications.identifier, user.id),
        eq(verifications.identifier, user.email),
        sql`${verifications.value} like ${`%${user.id}%`}`,
      ),
    )
  await tx
    .update(registrationInvites)
    .set({ revokedAt: now, note: null })
    .where(eq(registrationInvites.createdBy, user.id))
  await tx
    .update(registrationInviteUses)
    .set({ emailNormalized: null, requestHash: null })
    .where(eq(registrationInviteUses.userId, user.id))
  await tx
    .insert(usernameReservations)
    .values({
      username: user.username,
      userId: user.id,
      reservedUntil: new Date(now.getTime() + LIMITS.usernameReserveDays * 86_400_000),
    })
    .onConflictDoUpdate({
      target: usernameReservations.username,
      set: {
        userId: user.id,
        reservedUntil: new Date(now.getTime() + LIMITS.usernameReserveDays * 86_400_000),
      },
    })
  await tx
    .update(users)
    .set({
      name: '已注销用户',
      email: `deleted-${user.id}@deleted.invalid`,
      username: `deleted_${deps.newId().replaceAll('-', '').slice(0, 12)}`,
      image: null,
      avatarAttachmentId: null,
      bio: null,
      settings: {},
      role: 'user',
      banned: false,
      banReason: null,
      banExpires: null,
      deletedAt: now,
      authEpoch: sql`${users.authEpoch}+1`,
      profileVersion: sql`${users.profileVersion}+1`,
      meVersion: sql`${users.meVersion}+1`,
    })
    .where(eq(users.id, user.id))
  await recordUserChange(tx, deps, { userId: user.id, entityType: 'me', entityId: user.id })
  await enqueueRevocationHint(tx, deps, user.id)
  await writeAudit(tx, {
    actorId: user.id,
    action: 'account.deleted',
    targetType: 'user',
    targetId: user.id,
  })
}
