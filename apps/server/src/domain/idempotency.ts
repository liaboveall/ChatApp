/**
 * Idempotency keys (D-066, docs/04 section 11). The record is inserted in the same transaction as the business
 * change, so a rolled-back attempt leaves nothing behind and a committed one makes every replay a no-op. Records
 * never hold response bodies, passwords or tokens, only resource ids and a request fingerprint.
 */
import { AppError, LIMITS } from '@chatapp/contracts'
import { type DbOrTx, idempotencyRecords } from '@chatapp/db'
import { and, eq } from 'drizzle-orm'
import type { Deps } from './deps.ts'

export type IdempotencyScope = {
  /** Who is acting: a user id, or a fixed label for anonymous operations. */
  actorKey: string
  operation: string
  targetKey: string
  key: string
}

export type IdempotencyClaim =
  | { status: 'new'; id: string }
  | { status: 'replay'; resourceType: string | null; resourceId: string | null }

const KEY_FORMAT = /^[\x21-\x7e]+$/

export function assertIdempotencyKey(key: string): void {
  if (key.length < 1 || key.length > LIMITS.idempotencyKeyMaxLength || !KEY_FORMAT.test(key)) {
    throw new AppError('VALIDATION_FAILED', 'Invalid Idempotency-Key', {
      details: { field: 'idempotencyKey' },
    })
  }
}

/** Claims the scope, or reports a replay of the same request; the same key with another request is a 409. */
export async function claimIdempotency(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  scope: IdempotencyScope,
  requestHash: string,
): Promise<IdempotencyClaim> {
  const expiresAt = new Date(deps.clock.now().getTime() + LIMITS.idempotencyKeyTtlHours * 3_600_000)
  const inserted = await tx
    .insert(idempotencyRecords)
    .values({ ...scope, requestHash, expiresAt })
    .onConflictDoNothing()
    .returning({ id: idempotencyRecords.id })
  const created = inserted[0]
  if (created) return { status: 'new', id: created.id }

  const [existing] = await tx
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.actorKey, scope.actorKey),
        eq(idempotencyRecords.operation, scope.operation),
        eq(idempotencyRecords.targetKey, scope.targetKey),
        eq(idempotencyRecords.key, scope.key),
      ),
    )
    .limit(1)
  if (!existing) throw new Error('idempotency record vanished between insert and select')
  if (existing.requestHash !== requestHash) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key was used with a different request',
    )
  }
  return { status: 'replay', resourceType: existing.resourceType, resourceId: existing.resourceId }
}

export async function completeIdempotency(
  tx: DbOrTx,
  id: string,
  resource: { type: string; id: string | null },
): Promise<void> {
  await tx
    .update(idempotencyRecords)
    .set({ state: 'completed', resourceType: resource.type, resourceId: resource.id })
    .where(eq(idempotencyRecords.id, id))
}
