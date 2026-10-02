import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { AppError } from '@chatapp/contracts'
import { authorizationOrigins, executionDelegations, sessions, users, workItems } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import {
  endSession,
  listDevices,
  lockAndRevalidate,
  resolveSessionPrincipal,
  revokeAllDevices,
  revokeDevice,
  revokeOtherDevices,
} from '../../src/domain/sessions.ts'
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

async function twoDevices() {
  const deps = makeDeps(dbs.app.db)
  const user = await createActiveUser(deps, { username: 'multi' })
  const phone = await makePrincipal(deps, user)
  const laptop = await makePrincipal(deps, user)
  const delegate = async (originId: string) => {
    const [row] = await dbs.owner.db
      .insert(executionDelegations)
      .values({
        userId: user.id,
        originId,
        authEpoch: 0,
        restoreEpoch: deps.config.auth.restoreEpoch,
        purpose: 'agent_run',
        expiresAt: new Date(deps.clock.now().getTime() + 3_600_000),
      })
      .returning({ id: executionDelegations.id })
    return row?.id ?? ''
  }
  const statusOf = async (id: string) =>
    (
      await dbs.owner.db.select().from(executionDelegations).where(eq(executionDelegations.id, id))
    )[0]?.status
  return { deps, user, phone, laptop, delegate, statusOf }
}

const record = (p: { sessionId: string; userId: string; authEpoch: number; originId: string }) => ({
  id: p.sessionId,
  userId: p.userId,
  expiresAt: new Date(Date.now() + 60_000),
  authEpoch: p.authEpoch,
  authorizationOriginId: p.originId,
})

describe('the truth table of docs/03 section 5.9', () => {
  test('plain sign-out ends the session but not the work it delegated', async () => {
    const { deps, phone, delegate, statusOf } = await twoDevices()
    const delegationId = await delegate(phone.originId)
    await endSession(deps, {
      id: phone.sessionId,
      userId: phone.userId,
      authorizationOriginId: phone.originId,
    })
    expect(
      await dbs.owner.db.select().from(sessions).where(eq(sessions.id, phone.sessionId)),
    ).toHaveLength(0)
    const [origin] = await dbs.owner.db
      .select()
      .from(authorizationOrigins)
      .where(eq(authorizationOrigins.id, phone.originId))
    expect(origin?.endedAt).not.toBeNull()
    expect(origin?.revokedAt).toBeNull()
    expect(await statusOf(delegationId)).toBe('active')
    // Signing out twice is harmless.
    await endSession(deps, {
      id: phone.sessionId,
      userId: phone.userId,
      authorizationOriginId: phone.originId,
    })
  })

  test('revoking a device ends its sessions and cancels its work, leaving the others alone', async () => {
    const { deps, phone, laptop, delegate, statusOf } = await twoDevices()
    const phoneWork = await delegate(phone.originId)
    const laptopWork = await delegate(laptop.originId)
    await revokeDevice(deps, laptop, phone.originId)
    expect(
      await dbs.owner.db.select().from(sessions).where(eq(sessions.id, phone.sessionId)),
    ).toHaveLength(0)
    expect(
      await dbs.owner.db.select().from(sessions).where(eq(sessions.id, laptop.sessionId)),
    ).toHaveLength(1)
    expect(await statusOf(phoneWork)).toBe('revoked')
    expect(await statusOf(laptopWork)).toBe('active')
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, laptop.userId)))[0]?.authEpoch,
    ).toBe(0)
  })

  test('revoking a device of someone else or a made-up id is a 404', async () => {
    const { deps, laptop } = await twoDevices()
    const stranger = await createActiveUser(deps, { username: 'stranger' })
    const strangerPrincipal = await makePrincipal(deps, stranger)
    for (const originId of [strangerPrincipal.originId, deps.newId()]) {
      let error: unknown
      try {
        await revokeDevice(deps, laptop, originId)
      } catch (caught) {
        error = caught
      }
      expect((error as AppError).code).toBe('NOT_FOUND')
    }
    expect(
      await dbs.owner.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, strangerPrincipal.sessionId)),
    ).toHaveLength(1)
  })

  test('signing out other devices keeps the current origin and cancels the rest', async () => {
    const { deps, phone, laptop, delegate, statusOf } = await twoDevices()
    const phoneWork = await delegate(phone.originId)
    const laptopWork = await delegate(laptop.originId)
    await revokeOtherDevices(deps, laptop)
    expect(
      await dbs.owner.db.select().from(sessions).where(eq(sessions.id, laptop.sessionId)),
    ).toHaveLength(1)
    expect(
      await dbs.owner.db.select().from(sessions).where(eq(sessions.id, phone.sessionId)),
    ).toHaveLength(0)
    expect(await statusOf(phoneWork)).toBe('revoked')
    expect(await statusOf(laptopWork)).toBe('active')
    expect(await resolveSessionPrincipal(deps, record(laptop))).not.toBeNull()
  })

  test('security sign-out everywhere moves the epoch and revokes everything, including the caller', async () => {
    const { deps, phone, laptop, delegate, statusOf, user } = await twoDevices()
    const phoneWork = await delegate(phone.originId)
    const laptopWork = await delegate(laptop.originId)
    await revokeAllDevices(deps, laptop)
    expect(
      await dbs.owner.db.select().from(sessions).where(eq(sessions.userId, user.id)),
    ).toHaveLength(0)
    expect(await statusOf(phoneWork)).toBe('revoked')
    expect(await statusOf(laptopWork)).toBe('revoked')
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, user.id)))[0]?.authEpoch,
    ).toBe(1)
    expect(await resolveSessionPrincipal(deps, record(laptop))).toBeNull()
  })

  test('every security change leaves a durable realtime hint (the gateway also polls every 5 s)', async () => {
    const { deps, phone, laptop } = await twoDevices()
    await revokeDevice(deps, laptop, phone.originId)
    await revokeOtherDevices(deps, laptop)
    const hints = (await dbs.owner.db.select().from(workItems)).filter((w) => w.kind === 'realtime')
    expect(hints).toHaveLength(2)
    expect(hints.every((h) => h.status === 'pending' && h.entityId === laptop.userId)).toBe(true)
  })
})

describe('listing devices', () => {
  test('shows live sessions of this user only and marks the current one', async () => {
    const { deps, phone, laptop } = await twoDevices()
    const stranger = await createActiveUser(deps, { username: 'someone' })
    await makePrincipal(deps, stranger)
    await endSession(deps, {
      id: phone.sessionId,
      userId: phone.userId,
      authorizationOriginId: phone.originId,
    })
    const tablet = await makePrincipal(deps, { id: laptop.userId })
    const devices = await listDevices(deps, laptop)
    expect(devices.map((d) => d.originId).sort()).toEqual([laptop.originId, tablet.originId].sort())
    expect(devices.find((d) => d.originId === laptop.originId)?.current).toBe(true)
    expect(devices.find((d) => d.originId === tablet.originId)?.current).toBe(false)
  })
})

describe('resolveSessionPrincipal and lockAndRevalidate', () => {
  test('refuse expired sessions, epoch mismatches, foreign or revoked origins, wrong restore generation', async () => {
    const { deps, laptop, user } = await twoDevices()
    expect(await resolveSessionPrincipal(deps, record(laptop))).not.toBeNull()
    expect(
      await resolveSessionPrincipal(deps, {
        ...record(laptop),
        expiresAt: new Date(deps.clock.now().getTime() - 1),
      }),
    ).toBeNull()
    expect(await resolveSessionPrincipal(deps, { ...record(laptop), authEpoch: 99 })).toBeNull()

    const stranger = await createActiveUser(deps, { username: 'other1' })
    const strangerPrincipal = await makePrincipal(deps, stranger)
    expect(
      await resolveSessionPrincipal(deps, {
        ...record(laptop),
        authorizationOriginId: strangerPrincipal.originId,
      }),
    ).toBeNull()

    const afterRestore = {
      ...deps,
      config: { ...deps.config, auth: { ...deps.config.auth, restoreEpoch: 'new-generation' } },
    }
    expect(await resolveSessionPrincipal(afterRestore, record(laptop))).toBeNull()

    await dbs.owner.db.update(users).set({ banned: true }).where(eq(users.id, user.id))
    expect(await resolveSessionPrincipal(deps, record(laptop))).toBeNull()
    await dbs.owner.db.update(users).set({ banned: false }).where(eq(users.id, user.id))
    await dbs.owner.db
      .update(authorizationOrigins)
      .set({ revokedAt: new Date(), revokeReason: 'device_revoked' })
      .where(eq(authorizationOrigins.id, laptop.originId))
    expect(await resolveSessionPrincipal(deps, record(laptop))).toBeNull()
  })

  test('a write holding a stale principal is refused inside its transaction', async () => {
    const { deps, laptop } = await twoDevices()
    await revokeAllDevices(deps, laptop)
    let error: unknown
    try {
      await deps.db.transaction((tx) => lockAndRevalidate(tx, deps, laptop))
    } catch (caught) {
      error = caught
    }
    expect((error as AppError).code).toBe('UNAUTHENTICATED')
  })

  test('security operations serialize on the user lock: of a revoke and a write, one sees the other', async () => {
    const { deps, laptop } = await twoDevices()
    // Hold the user lock in one transaction while a revocation queues behind it, then commit and check the order.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked: () => void = () => {}
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve
    })
    const writer = deps.db.transaction(async (tx) => {
      await lockAndRevalidate(tx, deps, laptop)
      locked()
      await gate
      return 'write-committed'
    })
    await lockTaken
    const revoker = revokeAllDevices(deps, laptop).then(() => 'revoked')
    await new Promise((resolve) => setTimeout(resolve, 150))
    release()
    expect(await writer).toBe('write-committed')
    expect(await revoker).toBe('revoked')
  })
})
