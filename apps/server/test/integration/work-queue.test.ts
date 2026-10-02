import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { workItems } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { enqueueWork } from '../../src/domain/work.ts'
import {
  backoffMs,
  beginWork,
  claimReadyWork,
  completeWork,
  failWork,
  purgeFinishedWork,
  recoverExpiredWork,
  WORK_LIMITS,
  workBacklog,
} from '../../src/domain/work-queue.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makeDeps } from '../support/deps.ts'

let dbs: TestDatabases
beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
})

const row = async (id: string) =>
  (await dbs.owner.db.select().from(workItems).where(eq(workItems.id, id)))[0]

describe('enqueueWork', () => {
  test('is idempotent per dedupe key and returns the existing item', async () => {
    const deps = makeDeps(dbs.app.db)
    const a = await enqueueWork(deps.db, deps, {
      kind: 'email',
      dedupeKey: 'email:1',
      entityId: deps.newId(),
    })
    const b = await enqueueWork(deps.db, deps, { kind: 'email', dedupeKey: 'email:1' })
    expect(a.created).toBe(true)
    expect(b).toEqual({ id: a.id, created: false })
    expect(await dbs.owner.db.select().from(workItems)).toHaveLength(1)
  })

  test('commits or rolls back with the surrounding transaction', async () => {
    const deps = makeDeps(dbs.app.db)
    await expect(
      deps.db.transaction(async (tx) => {
        await enqueueWork(tx, deps, { kind: 'realtime', dedupeKey: 'rt:rolled-back' })
        throw new Error('business failure')
      }),
    ).rejects.toThrow('business failure')
    expect(await dbs.owner.db.select().from(workItems)).toHaveLength(0)
    await deps.db.transaction((tx) =>
      enqueueWork(tx, deps, { kind: 'realtime', dedupeKey: 'rt:kept' }),
    )
    expect(await dbs.owner.db.select().from(workItems)).toHaveLength(1)
  })

  test('refuses payloads that look like they carry secrets or personal data', async () => {
    const deps = makeDeps(dbs.app.db)
    for (const key of ['token', 'password', 'email', 'body', 'secret', 'authorization']) {
      await expect(
        enqueueWork(deps.db, deps, {
          kind: 'email',
          dedupeKey: `bad:${key}`,
          payload: { [key]: 'x' },
        }),
      ).rejects.toThrow('sensitive')
    }
    await expect(
      enqueueWork(deps.db, deps, {
        kind: 'email',
        dedupeKey: 'big',
        payload: { note: 'x'.repeat(3000) },
      }),
    ).rejects.toThrow('too large')
  })
})

describe('the dispatcher and consumer steps', () => {
  test('claiming leases the item, bumps the epoch and the delivery sequence', async () => {
    const deps = makeDeps(dbs.app.db)
    const { id } = await enqueueWork(deps.db, deps, { kind: 'email', dedupeKey: 'a' })
    const [claimed] = await claimReadyWork(deps, { limit: 10 })
    expect(claimed).toMatchObject({ id, kind: 'email', deliverySeq: 1, leaseEpoch: 1, attempts: 0 })
    expect(await row(id)).toMatchObject({ status: 'leased', leaseEpoch: 1, deliverySeq: 1 })
    // Nothing else is ready; a leased item is not handed out twice.
    expect(await claimReadyWork(deps, { limit: 10 })).toHaveLength(0)
  })

  test('items scheduled for later are not claimed early', async () => {
    const deps = makeDeps(dbs.app.db)
    await enqueueWork(deps.db, deps, {
      kind: 'email',
      dedupeKey: 'later',
      availableAt: new Date(deps.clock.now().getTime() + 60_000),
    })
    expect(await claimReadyWork(deps, { limit: 10 })).toHaveLength(0)
    deps.clock.advance(61_000)
    expect(await claimReadyWork(deps, { limit: 10 })).toHaveLength(1)
  })

  test('parallel dispatchers never claim the same item (SKIP LOCKED)', async () => {
    const deps = makeDeps(dbs.app.db)
    for (let i = 0; i < 40; i += 1)
      await enqueueWork(deps.db, deps, { kind: 'email', dedupeKey: `bulk-${i}` })
    const batches = await Promise.all(
      Array.from({ length: 4 }, () => claimReadyWork(deps, { limit: 15 })),
    )
    const ids = batches.flat().map((claimed) => claimed.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(40)
  })

  test('a stale lease epoch cannot start, complete or fail the item', async () => {
    const deps = makeDeps(dbs.app.db)
    const { id } = await enqueueWork(deps.db, deps, { kind: 'email', dedupeKey: 'epoch' })
    const [first] = await claimReadyWork(deps, { limit: 1 })
    expect(first).toBeDefined()
    // The lease expires and the item is claimed again under a new epoch.
    deps.clock.advance(WORK_LIMITS.dispatchLeaseMs + 1000)
    expect(await recoverExpiredWork(deps)).toEqual({ requeued: 1, dead: 0 })
    deps.clock.advance(backoffMs(1) + 1000)
    const [second] = await claimReadyWork(deps, { limit: 1 })
    expect(second?.leaseEpoch).toBe(2)

    const stale = { id, leaseEpoch: 1 }
    expect(await beginWork(deps, stale)).toBeNull()
    expect(await completeWork(deps, stale)).toBe(false)
    expect(await failWork(deps, stale, { kind: 'email', errorCode: 'x' })).toBe('stale')
    expect(await row(id)).toMatchObject({ status: 'leased', leaseEpoch: 2 })

    const current = { id, leaseEpoch: 2 }
    expect(await beginWork(deps, current)).not.toBeNull()
    expect(await completeWork(deps, current)).toBe(true)
    expect(await row(id)).toMatchObject({ status: 'done', lastErrorCode: null })
    expect((await row(id))?.finishedAt).not.toBeNull()
  })

  test('failures back off and finally land in dead', async () => {
    const deps = makeDeps(dbs.app.db)
    const { id } = await enqueueWork(deps.db, deps, { kind: 'email', dedupeKey: 'flaky' })
    const max = WORK_LIMITS.maxAttempts.email
    for (let attempt = 1; attempt <= max; attempt += 1) {
      const [claimed] = await claimReadyWork(deps, { limit: 1 })
      expect(claimed?.id).toBe(id)
      expect(await beginWork(deps, { id, leaseEpoch: claimed?.leaseEpoch ?? 0 })).not.toBeNull()
      const outcome = await failWork(
        deps,
        { id, leaseEpoch: claimed?.leaseEpoch ?? 0 },
        { kind: 'email', errorCode: 'smtp_unavailable' },
      )
      expect(outcome).toBe(attempt === max ? 'dead' : 'retry')
      if (attempt < max) {
        // Not available until the backoff has passed.
        expect(await claimReadyWork(deps, { limit: 1 })).toHaveLength(0)
        deps.clock.advance(backoffMs(attempt) + 1)
      }
    }
    expect(await row(id)).toMatchObject({
      status: 'dead',
      attempts: max,
      lastErrorCode: 'smtp_unavailable',
    })
    expect(await workBacklog(deps)).toMatchObject({ ready: 0, dead: 1 })
  })

  test('items stuck running past their lease are recovered; healthy ones are left alone', async () => {
    const deps = makeDeps(dbs.app.db)
    const stuck = await enqueueWork(deps.db, deps, { kind: 'email', dedupeKey: 'stuck' })
    const healthy = await enqueueWork(deps.db, deps, { kind: 'email', dedupeKey: 'healthy' })
    const claimed = await claimReadyWork(deps, { limit: 5 })
    for (const c of claimed) await beginWork(deps, { id: c.id, leaseEpoch: c.leaseEpoch })
    deps.clock.advance(WORK_LIMITS.runLeaseMs - 1000)
    await dbs.owner.db
      .update(workItems)
      .set({ leaseUntil: new Date(deps.clock.now().getTime() + 60_000) })
      .where(eq(workItems.id, healthy.id))
    deps.clock.advance(2000)
    expect(await recoverExpiredWork(deps)).toEqual({ requeued: 1, dead: 0 })
    expect(await row(stuck.id)).toMatchObject({
      status: 'retry',
      attempts: 1,
      lastErrorCode: 'lease_expired',
    })
    expect((await row(healthy.id))?.status).toBe('running')
  })

  test('finished items are purged after their retention, unfinished ones never', async () => {
    const deps = makeDeps(dbs.app.db)
    const done = await enqueueWork(deps.db, deps, { kind: 'realtime', dedupeKey: 'done' })
    await enqueueWork(deps.db, deps, { kind: 'realtime', dedupeKey: 'pending' })
    const [claimed] = await claimReadyWork(deps, { limit: 1, kinds: ['realtime'] })
    expect(claimed?.id).toBe(done.id)
    await completeWork(deps, { id: done.id, leaseEpoch: claimed?.leaseEpoch ?? 0 })
    expect(await purgeFinishedWork(deps)).toBe(0)
    deps.clock.advance((WORK_LIMITS.finishedRetentionDays + 1) * 86_400_000)
    expect(await purgeFinishedWork(deps)).toBe(1)
    expect(await dbs.owner.db.select().from(workItems)).toHaveLength(1)
  })
})
