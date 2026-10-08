/**
 * The work_items state machine (docs/03 section 7, D-056). Postgres is the source of truth; BullMQ is only the
 * transport. Every transition is a compare-and-set on `lease_epoch`, so a worker that lost its lease (or a retained
 * job redelivered later) cannot overwrite newer state, and a lost queue job is recovered by lease expiry.
 */
import type { WorkKind } from '@chatapp/contracts'
import { workItems } from '@chatapp/db'
import { and, asc, eq, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm'
import type { Deps } from './deps.ts'
import { inTransaction } from './tx.ts'

export type ClaimedWork = {
  id: string
  kind: WorkKind
  entityId: string | null
  entityVersion: number | null
  payload: Record<string, unknown>
  deliverySeq: number
  leaseEpoch: number
  attempts: number
}

export type WorkLease = { id: string; leaseEpoch: number }

export const WORK_LIMITS = {
  /** Lease while the item waits in the queue, and while a consumer runs it. */
  dispatchLeaseMs: 60_000,
  runLeaseMs: 120_000,
  maxAttempts: {
    realtime: 5,
    email: 5,
    media: 5,
    agent: 5,
    scheduled: 5,
    embedding: 5,
  } satisfies Record<WorkKind, number>,
  finishedRetentionDays: 7,
} as const

/** Exponential backoff with a ceiling: 5 s, 20 s, 80 s, 5 min, 5 min... */
export function backoffMs(attempts: number): number {
  return Math.min(5_000 * 4 ** Math.max(attempts - 1, 0), 300_000)
}

/** Dispatcher step: lease ready items (SKIP LOCKED, so several dispatchers never collide) and bump delivery_seq. */
export async function claimReadyWork(
  deps: Deps,
  options: { limit: number; kinds?: readonly WorkKind[]; embeddingVersions?: readonly string[] },
): Promise<ClaimedWork[]> {
  const now = deps.clock.now()
  return await inTransaction(deps.db, async (tx) => {
    const ready = await tx
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          inArray(workItems.status, ['pending', 'retry']),
          lte(workItems.availableAt, now),
          options.kinds ? inArray(workItems.kind, [...options.kinds]) : undefined,
          options.embeddingVersions === undefined
            ? undefined
            : options.embeddingVersions.length
              ? sql`(${workItems.kind} <> 'embedding' or ${inArray(sql`${workItems.payload}->>'modelVersion'`, [...options.embeddingVersions])})`
              : sql`${workItems.kind} <> 'embedding'`,
        ),
      )
      .orderBy(asc(workItems.availableAt), asc(workItems.id))
      .limit(options.limit)
      .for('update', { skipLocked: true })
    if (ready.length === 0) return []
    const claimed = await tx
      .update(workItems)
      .set({
        status: 'leased',
        leaseEpoch: sql`${workItems.leaseEpoch} + 1`,
        leaseUntil: new Date(now.getTime() + WORK_LIMITS.dispatchLeaseMs),
        deliverySeq: sql`${workItems.deliverySeq} + 1`,
      })
      .where(
        inArray(
          workItems.id,
          ready.map((row) => row.id),
        ),
      )
      .returning()
    return claimed.map((row) => ({
      id: row.id,
      kind: row.kind,
      entityId: row.entityId,
      entityVersion: row.entityVersion,
      payload: row.payload,
      deliverySeq: row.deliverySeq,
      leaseEpoch: row.leaseEpoch,
      attempts: row.attempts,
    }))
  })
}

/**
 * Consumer step 1: `leased` becomes `running` only for the epoch that was dispatched. Returns the item, or null when
 * the delivery is stale (another epoch owns it, or it already finished) and must be skipped.
 */
export async function beginWork(deps: Deps, lease: WorkLease): Promise<ClaimedWork | null> {
  const now = deps.clock.now()
  const [row] = await deps.db
    .update(workItems)
    .set({ status: 'running', leaseUntil: new Date(now.getTime() + WORK_LIMITS.runLeaseMs) })
    .where(
      and(
        eq(workItems.id, lease.id),
        eq(workItems.leaseEpoch, lease.leaseEpoch),
        eq(workItems.status, 'leased'),
      ),
    )
    .returning()
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    entityId: row.entityId,
    entityVersion: row.entityVersion,
    payload: row.payload,
    deliverySeq: row.deliverySeq,
    leaseEpoch: row.leaseEpoch,
    attempts: row.attempts,
  }
}

/** Marks an item done. Used by consumers after their business effect committed, and by the dispatcher for realtime hints. */
export async function completeWork(deps: Deps, lease: WorkLease): Promise<boolean> {
  const rows = await deps.db
    .update(workItems)
    .set({ status: 'done', finishedAt: deps.clock.now(), leaseUntil: null, lastErrorCode: null })
    .where(
      and(
        eq(workItems.id, lease.id),
        eq(workItems.leaseEpoch, lease.leaseEpoch),
        inArray(workItems.status, ['leased', 'running']),
      ),
    )
    .returning({ id: workItems.id })
  return rows.length === 1
}

/** Long Agent calls keep the durable work lease alive independently of BullMQ's lock. */
export async function renewWork(deps: Deps, lease: WorkLease): Promise<boolean> {
  const rows = await deps.db
    .update(workItems)
    .set({ leaseUntil: new Date(deps.clock.now().getTime() + WORK_LIMITS.runLeaseMs) })
    .where(
      and(
        eq(workItems.id, lease.id),
        eq(workItems.leaseEpoch, lease.leaseEpoch),
        eq(workItems.status, 'running'),
      ),
    )
    .returning({ id: workItems.id })
  return rows.length === 1
}

export type FailureResult = 'retry' | 'dead' | 'stale'

/** A failed attempt: back off and retry, or give up (`dead`) at the cap so the failure is visible instead of looping. */
export async function failWork(
  deps: Deps,
  lease: WorkLease,
  failure: { kind: WorkKind; errorCode: string },
): Promise<FailureResult> {
  const now = deps.clock.now()
  return await inTransaction(deps.db, async (tx) => {
    const [row] = await tx
      .select({ attempts: workItems.attempts })
      .from(workItems)
      .where(
        and(
          eq(workItems.id, lease.id),
          eq(workItems.leaseEpoch, lease.leaseEpoch),
          inArray(workItems.status, ['leased', 'running']),
        ),
      )
      .for('update')
    if (!row) return 'stale'
    const attempts = row.attempts + 1
    const dead = attempts >= WORK_LIMITS.maxAttempts[failure.kind]
    await tx
      .update(workItems)
      .set({
        attempts,
        status: dead ? 'dead' : 'retry',
        availableAt: dead ? undefined : new Date(now.getTime() + backoffMs(attempts)),
        leaseUntil: null,
        lastErrorCode: failure.errorCode.slice(0, 64),
        finishedAt: dead ? now : null,
      })
      .where(eq(workItems.id, lease.id))
    return dead ? 'dead' : 'retry'
  })
}

/**
 * Reconcile step (every minute, straight from Postgres): items whose lease expired (worker crash, lost queue job,
 * Valkey down) go back to `retry`, counting as an attempt; items past the attempt cap become `dead`.
 */
export async function recoverExpiredWork(
  deps: Deps,
  limit = 200,
): Promise<{ requeued: number; dead: number }> {
  const now = deps.clock.now()
  return await inTransaction(deps.db, async (tx) => {
    const expired = await tx
      .select({ id: workItems.id, kind: workItems.kind, attempts: workItems.attempts })
      .from(workItems)
      .where(and(inArray(workItems.status, ['leased', 'running']), lt(workItems.leaseUntil, now)))
      .orderBy(asc(workItems.id))
      .limit(limit)
      .for('update', { skipLocked: true })
    let requeued = 0
    let dead = 0
    for (const row of expired) {
      const attempts = row.attempts + 1
      const giveUp = attempts >= WORK_LIMITS.maxAttempts[row.kind]
      await tx
        .update(workItems)
        .set({
          attempts,
          status: giveUp ? 'dead' : 'retry',
          availableAt: giveUp ? undefined : new Date(now.getTime() + backoffMs(attempts)),
          leaseUntil: null,
          lastErrorCode: 'lease_expired',
          finishedAt: giveUp ? now : null,
        })
        .where(eq(workItems.id, row.id))
      if (giveUp) dead += 1
      else requeued += 1
    }
    return { requeued, dead }
  })
}

/** Deletes finished items after their retention (docs/04 section 10: terminal work metadata is kept 7 days). */
export async function purgeFinishedWork(deps: Deps): Promise<number> {
  const cutoff = new Date(
    deps.clock.now().getTime() - WORK_LIMITS.finishedRetentionDays * 86_400_000,
  )
  const rows = await deps.db
    .delete(workItems)
    .where(
      and(
        inArray(workItems.status, ['done', 'dead']),
        isNotNull(workItems.finishedAt),
        lt(workItems.finishedAt, cutoff),
      ),
    )
    .returning({ id: workItems.id })
  return rows.length
}

/** Counts for monitoring and the dead-letter alert. */
export async function workBacklog(
  deps: Deps,
): Promise<{ ready: number; dead: number; oldestReadyAgeMs: number | null }> {
  const now = deps.clock.now()
  const [ready] = await deps.db
    .select({
      n: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${workItems.availableAt})`,
    })
    .from(workItems)
    .where(and(inArray(workItems.status, ['pending', 'retry']), lte(workItems.availableAt, now)))
  const [dead] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(workItems)
    .where(eq(workItems.status, 'dead'))
  const oldest = ready?.oldest ? new Date(ready.oldest) : null
  return {
    ready: ready?.n ?? 0,
    dead: dead?.n ?? 0,
    oldestReadyAgeMs: oldest ? now.getTime() - oldest.getTime() : null,
  }
}
