import type { DeletionIntent } from '@chatapp/contracts'
import { agentMemories, attachments, conversations, type Tx, users } from '@chatapp/db'
import { eq, sql } from 'drizzle-orm'
import { applyAccountDeletion } from './account-deletion.ts'
import { applyAgentConversationDeletion } from './agent-runs.ts'
import { lockStorage } from './attachment-common.ts'
import { writeAudit } from './audit.ts'
import { bumpConversation, recordUserChange } from './changes.ts'
import type { Deps } from './deps.ts'
import { deleteMemoryRow } from './memories.ts'
import { applyMessageDeletion } from './messages.ts'
import { applyRetention } from './retention.ts'
import { lockUsers } from './sessions.ts'
import { retireAttachment } from './uploads.ts'

/** Every accepted intent enters here, including intents whose local prepared row was lost with the source host. */
export async function applyDeletion(
  tx: Tx,
  deps: Deps,
  intent: DeletionIntent,
  actorId: string | null,
): Promise<void> {
  const owners = [actorId, 'userId' in intent.target ? intent.target.userId : null].filter(
    (id): id is string => id !== null,
  )
  if (intent.action === 'message_recall' || intent.action === 'message_delete') {
    const rows = await tx
      .select({ id: attachments.uploaderId })
      .from(attachments)
      .where(eq(attachments.messageId, intent.target.id))
    owners.push(...rows.map((row) => row.id))
  } else if (intent.action === 'agent_conversation_delete') {
    const rows = await tx
      .select({ id: attachments.uploaderId })
      .from(attachments)
      .where(eq(attachments.conversationId, intent.target.id))
    owners.push(...rows.map((row) => row.id))
  } else if (intent.action === 'account_delete') {
    // Account deletion spans memberships, private runs and quotas. All user locks precede every conversation lock.
    owners.push(...(await tx.select({ id: users.id }).from(users)).map((row) => row.id))
  }
  const locked = await lockUsers(tx, owners)
  // The accepting actor may have registered after the restored snapshot. Their signed intent remains valid.
  const auditActor = locked.some((user) => user.id === actorId) ? actorId : null
  switch (intent.action) {
    case 'message_recall':
    case 'message_delete':
      await applyMessageDeletion(tx, deps, intent, auditActor)
      return
    case 'memory_delete': {
      const [row] = await tx
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.id, intent.target.id))
        .for('update')
      if (!row) return
      if (row.userId !== intent.target.userId) throw new Error('frozen memory owner mismatch')
      if (row.deletedAt) return
      if (row.contentVersion > intent.target.contentVersion)
        throw new Error('frozen memory version mismatch')
      await deleteMemoryRow(tx, deps, intent.target.userId, intent.target.id)
      await writeAudit(tx, {
        actorId: auditActor,
        action: 'memory.deleted',
        targetType: 'agent_memory',
        targetId: intent.target.id,
      })
      return
    }
    case 'agent_conversation_delete':
      await applyAgentConversationDeletion(tx, deps, intent.target.id, intent.target.userId)
      return
    case 'attachment_delete': {
      const boundConversations = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.avatarAttachmentId, intent.target.id))
        .orderBy(conversations.id)
        .for('update')
      await lockStorage(tx)
      const [row] = await tx
        .select()
        .from(attachments)
        .where(eq(attachments.id, intent.target.id))
        .for('update')
      if (!row || row.deletedAt) return
      if (
        row.uploaderId !== intent.target.userId ||
        row.generation > intent.target.generation ||
        row.version > intent.target.contentVersion
      )
        throw new Error('frozen attachment identity or version mismatch')
      if (row.messageId)
        throw new Error('independent attachment deletion cannot remove a bound message attachment')
      const affected = await tx
        .update(users)
        .set({
          avatarAttachmentId: null,
          profileVersion: sql`${users.profileVersion}+1`,
          meVersion: sql`${users.meVersion}+1`,
        })
        .where(eq(users.avatarAttachmentId, row.id))
        .returning({ id: users.id })
      for (const user of affected)
        await recordUserChange(tx, deps, { userId: user.id, entityType: 'me', entityId: user.id })
      for (const conversation of boundConversations) {
        await tx
          .update(conversations)
          .set({ avatarAttachmentId: null })
          .where(eq(conversations.id, conversation.id))
        await bumpConversation(tx, deps, conversation.id, { metadata: true })
      }
      if (await retireAttachment(tx, deps, row.id))
        throw new Error('accepted attachment unexpectedly prepared again')
      if (intent.target.finalStatus === 'failed')
        await tx.update(attachments).set({ status: 'failed' }).where(eq(attachments.id, row.id))
      await writeAudit(tx, {
        actorId: auditActor,
        action: 'attachment.deleted',
        targetType: 'attachment',
        targetId: row.id,
      })
      return
    }
    case 'retention':
      await applyRetention(
        tx,
        deps,
        new Date(intent.target.cutoff),
        intent.target.ruleVersion === 2 ? intent.target.runContentDays : 30,
      )
      return
    case 'account_delete':
      await applyAccountDeletion(tx, deps, intent)
      return
    default:
      throw new Error('deletion action is not implemented')
  }
}
