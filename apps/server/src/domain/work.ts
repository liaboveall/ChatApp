/**
 * Durable work intents (D-056). Callers pass the transaction of the business change, so the intent commits or rolls
 * back with it; the dispatcher turns committed intents into queue jobs. Payloads carry identifiers only.
 */
import type { WorkKind } from '@chatapp/contracts'
import { type DbOrTx, workItems } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import type { Deps } from './deps.ts'

export type WorkInput = {
  kind: WorkKind
  /** Unique per logical intent: re-enqueueing the same intent is a no-op. */
  dedupeKey: string
  entityId?: string
  entityVersion?: number
  payload?: Record<string, string | number | boolean | null>
  availableAt?: Date
}

const FORBIDDEN_PAYLOAD_KEY = /token|password|secret|email|body|cookie|authorization/i
const MAX_PAYLOAD_BYTES = 2048

export async function enqueueWork(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  input: WorkInput,
): Promise<{ id: string; created: boolean }> {
  const payload = input.payload ?? {}
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_PAYLOAD_KEY.test(key)) {
      throw new Error(`work payload key "${key}" looks sensitive; payloads carry identifiers only`)
    }
  }
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) throw new Error('work payload too large')

  const inserted = await tx
    .insert(workItems)
    .values({
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      entityId: input.entityId,
      entityVersion: input.entityVersion,
      payload,
      // The application clock decides readiness (tests move it); the database default would use its own clock.
      availableAt: input.availableAt ?? deps.clock.now(),
    })
    .onConflictDoNothing({ target: workItems.dedupeKey })
    .returning({ id: workItems.id })
  const created = inserted[0]
  if (created) return { id: created.id, created: true }
  const [existing] = await tx
    .select({ id: workItems.id })
    .from(workItems)
    .where(eq(workItems.dedupeKey, input.dedupeKey))
    .limit(1)
  if (!existing) throw new Error('work item vanished between insert and select')
  return { id: existing.id, created: false }
}
