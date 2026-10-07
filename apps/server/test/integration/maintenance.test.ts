import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  authChallenges,
  authorizationOrigins,
  executionDelegations,
  idempotencyRecords,
  registrationInvites,
  registrationInviteUses,
  sessions,
  usernameReservations,
  verifications,
} from '@chatapp/db'
import { eq } from 'drizzle-orm'
import {
  purgeExpiredRecords,
  purgeSessionsAndOrigins,
  runMaintenanceTask,
} from '../../src/domain/maintenance.ts'
import { createMaintenance } from '../../src/jobs/maintenance.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps, makePrincipal } from '../support/deps.ts'

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

const DAY = 86_400_000

describe('sessions and origins', () => {
  test('an expired session ends its origin (work continues) and is removed; live ones are untouched', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'cleanup1' })
    const old = await makePrincipal(deps, user)
    const live = await makePrincipal(deps, user)
    await dbs.owner.db
      .update(sessions)
      .set({ expiresAt: new Date(deps.clock.now().getTime() - 1_000) })
      .where(eq(sessions.id, old.sessionId))
    const result = await purgeSessionsAndOrigins(deps)
    expect(result).toMatchObject({ sessionsExpired: 1 })
    expect(
      await dbs.owner.db.select().from(sessions).where(eq(sessions.id, old.sessionId)),
    ).toHaveLength(0)
    expect(
      await dbs.owner.db.select().from(sessions).where(eq(sessions.id, live.sessionId)),
    ).toHaveLength(1)
    const [oldOrigin] = await dbs.owner.db
      .select()
      .from(authorizationOrigins)
      .where(eq(authorizationOrigins.id, old.originId))
    expect(oldOrigin?.endedAt).not.toBeNull()
    expect(oldOrigin?.revokedAt).toBeNull()
    const [liveOrigin] = await dbs.owner.db
      .select()
      .from(authorizationOrigins)
      .where(eq(authorizationOrigins.id, live.originId))
    expect(liveOrigin?.endedAt).toBeNull()
  })

  test('terminal delegations and unreferenced origins go only after 30 days, and never while work is still active', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'cleanup2' })
    const a = await makePrincipal(deps, user)
    const b = await makePrincipal(deps, user)
    const delegate = async (originId: string, status: 'active' | 'revoked') =>
      (
        await dbs.owner.db
          .insert(executionDelegations)
          .values({
            userId: user.id,
            originId,
            authEpoch: 0,
            restoreEpoch: deps.config.auth.restoreEpoch,
            purpose: 'agent_run',
            status,
            revokedAt: status === 'revoked' ? new Date() : null,
            expiresAt: new Date(deps.clock.now().getTime() + DAY),
          })
          .returning({ id: executionDelegations.id })
      )[0]?.id ?? ''
    await delegate(a.originId, 'revoked')
    const stillActive = await delegate(b.originId, 'active')
    for (const origin of [a.originId, b.originId]) {
      await dbs.owner.db
        .update(authorizationOrigins)
        .set({ endedAt: new Date(deps.clock.now().getTime() - 40 * DAY) })
        .where(eq(authorizationOrigins.id, origin))
    }
    await dbs.owner.db.delete(sessions).where(eq(sessions.userId, user.id))

    // Not yet 30 days past the delegation's creation: nothing is removed.
    expect(await purgeSessionsAndOrigins(deps)).toMatchObject({
      delegationsPurged: 0,
      originsPurged: 0,
    })
    deps.clock.advance(31 * DAY)
    const result = await purgeSessionsAndOrigins(deps)
    expect(result.delegationsPurged).toBe(1) // the revoked one
    // a's origin had only the terminal delegation: gone. b's origin still has an active delegation: kept.
    expect(
      await dbs.owner.db
        .select()
        .from(authorizationOrigins)
        .where(eq(authorizationOrigins.id, a.originId)),
    ).toHaveLength(0)
    expect(
      await dbs.owner.db
        .select()
        .from(authorizationOrigins)
        .where(eq(authorizationOrigins.id, b.originId)),
    ).toHaveLength(1)
    expect(
      await dbs.owner.db
        .select()
        .from(executionDelegations)
        .where(eq(executionDelegations.id, stillActive)),
    ).toHaveLength(1)
  })
})

describe('retention of small records (docs/04 section 10)', () => {
  test('removes expired idempotency keys, old credential metadata, stale ceremonies, released registrations and lapsed reservations', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'cleanup3' })
    const now = deps.clock.now().getTime()
    const at = (offsetDays: number) => new Date(now + offsetDays * DAY)

    await dbs.owner.db.insert(idempotencyRecords).values([
      {
        actorKey: 'a',
        operation: 'o',
        targetKey: 't',
        key: 'old',
        requestHash: 'h',
        expiresAt: at(-1),
      },
      {
        actorKey: 'a',
        operation: 'o',
        targetKey: 't',
        key: 'new',
        requestHash: 'h',
        expiresAt: at(1),
      },
    ])
    const base = {
      userId: user.id,
      purpose: 'verify_email' as const,
      emailHash: 'e',
      authEpoch: 0,
      restoreEpoch: 'r',
    }
    await dbs.owner.db.insert(authChallenges).values([
      { ...base, tokenHash: 'expired-long-ago', expiresAt: at(-8) },
      {
        ...base,
        purpose: 'reset_password' as const,
        tokenHash: 'expired-yesterday-with-copy',
        expiresAt: at(-1),
        deliveryCiphertext: 'c',
        deliveryNonce: 'n',
        deliveryKeyVersion: 1,
      },
      { ...base, tokenHash: 'consumed-long-ago', expiresAt: at(-9), consumedAt: at(-8) },
    ])
    await dbs.owner.db.insert(verifications).values([
      { identifier: 'a', value: 'x', expiresAt: at(-2) },
      { identifier: 'b', value: 'x', expiresAt: at(1) },
    ])
    const [invite] = await dbs.owner.db
      .insert(registrationInvites)
      .values({ codeHash: 'h', createdBy: user.id, maxUses: 1, expiresAt: at(1) })
      .returning({ id: registrationInvites.id })
    await dbs.owner.db.insert(registrationInviteUses).values([
      {
        inviteId: invite?.id ?? '',
        inviterId: user.id,
        status: 'released',
        releasedAt: at(-31),
        expiresAt: at(-31),
      },
      {
        inviteId: invite?.id ?? '',
        inviterId: user.id,
        status: 'released',
        releasedAt: at(-5),
        expiresAt: at(-5),
      },
    ])
    await dbs.owner.db.insert(usernameReservations).values([
      { username: 'lapsed', reservedUntil: at(-1) },
      { username: 'permanent', reservedUntil: null },
      { username: 'future', reservedUntil: at(10) },
    ])

    expect(await purgeExpiredRecords(deps)).toEqual({
      idempotencyRecords: 1,
      authChallenges: 2, // expired > 7 days, consumed > 7 days
      passkeyCeremonies: 1,
      releasedRegistrations: 1,
      usernameReservations: 1,
    })
    // The yesterday-expired credential stays as metadata, but its encrypted delivery copy is gone.
    const [kept] = await dbs.owner.db.select().from(authChallenges)
    expect(kept).toMatchObject({
      tokenHash: 'expired-yesterday-with-copy',
      deliveryCiphertext: null,
      deliveryNonce: null,
    })
    expect(
      (await dbs.owner.db.select().from(usernameReservations)).map((r) => r.username).sort(),
    ).toEqual(['future', 'permanent'])
    // Running it again changes nothing.
    expect(Object.values(await purgeExpiredRecords(deps)).every((n) => n === 0)).toBe(true)
  })
})

test('R3: local schedules and separate workers skip a running storage reconciliation, then can run again', async () => {
  const deps = makeDeps(dbs.app.db)
  if (!deps.blobs) throw new Error('store missing')
  let calls = 0
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const scoped = {
    ...deps,
    blobs: {
      ...deps.blobs,
      list: async () => {
        calls++
        reached.resolve()
        await release.promise
        return { items: [], nextCursor: null }
      },
    },
  }
  const one = createMaintenance({ deps: scoped, log: deps.log }),
    two = createMaintenance({ deps: scoped, log: deps.log })
  const first = one.storageReconcile()
  await reached.promise
  try {
    await one.storageReconcile()
    await two.storageReconcile()
    expect(calls).toBe(1)
  } finally {
    release.resolve()
    await first
    await one.stop()
    await two.stop()
  }
  await two.storageReconcile()
  expect(calls).toBe(2)
})
test('R3: an errored maintenance task releases its advisory lock', async () => {
  const deps = makeDeps(dbs.app.db)
  await expect(
    runMaintenanceTask(deps, 'test-release', async () => {
      throw new Error('failure')
    }),
  ).rejects.toThrow('failure')
  let ran = false
  await runMaintenanceTask(deps, 'test-release', async () => {
    ran = true
  })
  expect(ran).toBe(true)
})
