import { auditLogs, type DbOrTx } from '@chatapp/db'

/** Audit rows hold ids and metadata only (SEC-21): never bodies, emails, tokens or passwords. */
export type AuditEntry = {
  actorId?: string | null
  action: string
  targetType?: string
  targetId?: string
  metadata?: Record<string, string | number | boolean | null>
  requestId?: string
}

export async function writeAudit(tx: DbOrTx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ?? {},
    requestId: entry.requestId,
  })
}
