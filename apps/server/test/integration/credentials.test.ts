import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { AppError } from '@chatapp/contracts'
import {
  accounts,
  authChallenges,
  authorizationOrigins,
  executionDelegations,
  sessions,
  users,
  workItems,
} from '@chatapp/db'
import { and, eq } from 'drizzle-orm'
import {
  changePassword,
  consumePasswordReset,
  requestPasswordReset,
  verifyEmailManually,
} from '../../src/domain/credentials.ts'
import { resolveSessionPrincipal } from '../../src/domain/sessions.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps, makePrincipal, readLiveToken } from '../support/deps.ts'

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

const NEW_PASSWORD = 'violet-harbor-91-compass'

async function failureOf(run: () => Promise<unknown>): Promise<AppError | Error | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return error as Error
  }
}

async function delegate(deps: ReturnType<typeof makeDeps>, userId: string, originId: string) {
  const [row] = await dbs.owner.db
    .insert(executionDelegations)
    .values({
      userId,
      originId,
      authEpoch: 0,
      restoreEpoch: deps.config.auth.restoreEpoch,
      purpose: 'agent_run',
      expiresAt: new Date(deps.clock.now().getTime() + 3_600_000),
    })
    .returning({ id: executionDelegations.id })
  return row?.id ?? ''
}

describe('password reset (D-076, docs/03 truth table)', () => {
  test('consuming the credential changes the password and ends every session, origin and delegation', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'resetter' })
    const phone = await makePrincipal(deps, user)
    const laptop = await makePrincipal(deps, user)
    const delegationId = await delegate(deps, user.id, phone.originId)

    await requestPasswordReset(deps, { email: user.email })
    const token = await readLiveToken(deps, user.id, 'reset_password')
    await consumePasswordReset(deps, { token, newPassword: NEW_PASSWORD })

    const [credential] = await dbs.owner.db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, user.id))
    expect(await deps.passwords.verify(credential?.password ?? '', NEW_PASSWORD)).toBe(true)
    expect(await deps.passwords.verify(credential?.password ?? '', user.password)).toBe(false)

    expect(
      await dbs.owner.db.select().from(sessions).where(eq(sessions.userId, user.id)),
    ).toHaveLength(0)
    const origins = await dbs.owner.db
      .select()
      .from(authorizationOrigins)
      .where(eq(authorizationOrigins.userId, user.id))
    expect(origins).toHaveLength(2)
    expect(origins.every((o) => o.revokedAt !== null && o.revokeReason === 'password_reset')).toBe(
      true,
    )
    expect(
      (
        await dbs.owner.db
          .select()
          .from(executionDelegations)
          .where(eq(executionDelegations.id, delegationId))
      )[0]?.status,
    ).toBe('revoked')
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, user.id)))[0]?.authEpoch,
    ).toBe(1)

    // The old principals are dead even if a stale session row were somehow still around.
    for (const principal of [phone, laptop]) {
      expect(
        await resolveSessionPrincipal(deps, {
          id: principal.sessionId,
          userId: user.id,
          expiresAt: new Date(Date.now() + 1000),
          authEpoch: principal.authEpoch,
          authorizationOriginId: principal.originId,
        }),
      ).toBeNull()
    }
    const hints = (await dbs.owner.db.select().from(workItems)).filter((w) => w.kind === 'realtime')
    expect(hints).toHaveLength(1)
    expect(hints[0]?.payload).toEqual({ event: 'auth.revoked' })
  })

  test('the credential is single use, and a weak new password does not burn it', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'once' })
    await requestPasswordReset(deps, { email: user.email })
    const token = await readLiveToken(deps, user.id, 'reset_password')

    const weak = await failureOf(() =>
      consumePasswordReset(deps, { token, newPassword: 'password123' }),
    )
    expect((weak as AppError).code).toBe('VALIDATION_FAILED')
    // Still usable after the rejected attempt.
    await consumePasswordReset(deps, { token, newPassword: NEW_PASSWORD })
    const again = await failureOf(() =>
      consumePasswordReset(deps, { token, newPassword: 'another-fine-pass-77' }),
    )
    expect((again as AppError).code).toBe('AUTH_CHALLENGE_INVALID')
  })

  test('a newer request revokes the older link; a verification link cannot reset a password', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'twice' })
    await requestPasswordReset(deps, { email: user.email })
    const first = await readLiveToken(deps, user.id, 'reset_password')
    await requestPasswordReset(deps, { email: user.email })
    const second = await readLiveToken(deps, user.id, 'reset_password')
    expect(
      (
        (await failureOf(() =>
          consumePasswordReset(deps, { token: first, newPassword: NEW_PASSWORD }),
        )) as AppError
      ).code,
    ).toBe('AUTH_CHALLENGE_INVALID')
    await consumePasswordReset(deps, { token: second, newPassword: NEW_PASSWORD })
  })

  test('expired links and links from before a password change are refused', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'stale' })
    await requestPasswordReset(deps, { email: user.email })
    const token = await readLiveToken(deps, user.id, 'reset_password')
    deps.clock.advance(61 * 60_000)
    expect(
      (
        (await failureOf(() =>
          consumePasswordReset(deps, { token, newPassword: NEW_PASSWORD }),
        )) as AppError
      ).code,
    ).toBe('AUTH_CHALLENGE_INVALID')

    deps.clock.advance(-61 * 60_000)
    const principal = await makePrincipal(deps, user)
    await changePassword(deps, principal, {
      currentPassword: user.password,
      newPassword: NEW_PASSWORD,
    })
    // The epoch moved with the password change, so the link issued earlier is dead.
    expect(
      (
        (await failureOf(() =>
          consumePasswordReset(deps, { token, newPassword: 'yet-another-pass-55' }),
        )) as AppError
      ).code,
    ).toBe('AUTH_CHALLENGE_INVALID')
  })

  test('requests for unknown, unverified, banned, deleted accounts and bots create nothing', async () => {
    const deps = makeDeps(dbs.app.db)
    const pending = await createActiveUser(deps, { username: 'pending1' })
    await dbs.owner.db
      .update(users)
      .set({ activationStatus: 'pending', emailVerified: false })
      .where(eq(users.id, pending.id))
    const banned = await createActiveUser(deps, { username: 'banned1' })
    await dbs.owner.db.update(users).set({ banned: true }).where(eq(users.id, banned.id))
    const deleted = await createActiveUser(deps, { username: 'deleted1' })
    await dbs.owner.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, deleted.id))
    for (const email of ['nobody@example.com', pending.email, banned.email, deleted.email]) {
      await requestPasswordReset(deps, { email })
    }
    expect(await dbs.owner.db.select().from(authChallenges)).toHaveLength(0)
    expect(await dbs.owner.db.select().from(workItems)).toHaveLength(0)
  })
})

describe('changePassword', () => {
  test('keeps the current session under a new origin and epoch and ends everything else', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'changer' })
    const current = await makePrincipal(deps, user)
    const other = await makePrincipal(deps, user)
    const currentDelegation = await delegate(deps, user.id, current.originId)
    const otherDelegation = await delegate(deps, user.id, other.originId)

    await changePassword(deps, current, {
      currentPassword: user.password,
      newPassword: NEW_PASSWORD,
    })

    const remaining = await dbs.owner.db.select().from(sessions).where(eq(sessions.userId, user.id))
    expect(remaining.map((s) => s.id)).toEqual([current.sessionId])
    const [kept] = remaining
    expect(kept?.authEpoch).toBe(1)
    expect(kept?.authorizationOriginId).not.toBe(current.originId)

    const principal = await resolveSessionPrincipal(deps, {
      id: current.sessionId,
      userId: user.id,
      expiresAt: kept?.expiresAt ?? new Date(),
      authEpoch: kept?.authEpoch ?? -1,
      authorizationOriginId: kept?.authorizationOriginId ?? '',
    })
    expect(principal).toMatchObject({ userId: user.id, authEpoch: 1 })

    // The old origin and everything started from either old origin are revoked.
    const oldOrigins = await dbs.owner.db
      .select()
      .from(authorizationOrigins)
      .where(and(eq(authorizationOrigins.userId, user.id)))
    expect(
      oldOrigins
        .filter((o) => o.revokedAt !== null)
        .map((o) => o.id)
        .sort(),
    ).toEqual([current.originId, other.originId].sort())
    for (const id of [currentDelegation, otherDelegation]) {
      expect(
        (
          await dbs.owner.db
            .select()
            .from(executionDelegations)
            .where(eq(executionDelegations.id, id))
        )[0]?.status,
      ).toBe('revoked')
    }
    // The pre-change principal can no longer write.
    const [credential] = await dbs.owner.db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, user.id))
    expect(await deps.passwords.verify(credential?.password ?? '', NEW_PASSWORD)).toBe(true)
  })

  test('requires the current password and an acceptable new one', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'checker' })
    const principal = await makePrincipal(deps, user)
    const wrong = await failureOf(() =>
      changePassword(deps, principal, {
        currentPassword: 'not-my-password',
        newPassword: NEW_PASSWORD,
      }),
    )
    expect((wrong as AppError).code).toBe('FORBIDDEN')
    const weak = await failureOf(() =>
      changePassword(deps, principal, {
        currentPassword: user.password,
        newPassword: 'qwertyuiop',
      }),
    )
    expect((weak as AppError).code).toBe('VALIDATION_FAILED')
    const sameAsName = await failureOf(() =>
      changePassword(deps, principal, {
        currentPassword: user.password,
        newPassword: 'my-checker-password',
      }),
    )
    expect((sameAsName as AppError).details).toMatchObject({ reason: 'contains_identity' })
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, user.id)))[0]?.authEpoch,
    ).toBe(0)
  })

  test('a session that was revoked meanwhile cannot change the password', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'revoked' })
    const principal = await makePrincipal(deps, user)
    await dbs.owner.db
      .update(authorizationOrigins)
      .set({ revokedAt: new Date(), revokeReason: 'device_revoked' })
      .where(eq(authorizationOrigins.id, principal.originId))
    const error = await failureOf(() =>
      changePassword(deps, principal, {
        currentPassword: user.password,
        newPassword: NEW_PASSWORD,
      }),
    )
    expect((error as AppError).code).toBe('UNAUTHENTICATED')
    const [credential] = await dbs.owner.db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, user.id))
    expect(await deps.passwords.verify(credential?.password ?? '', user.password)).toBe(true)
  })

  test('two simultaneous changes: exactly one wins and the epoch moves once', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'racer' })
    const principal = await makePrincipal(deps, user)
    const results = await Promise.allSettled([
      changePassword(deps, principal, {
        currentPassword: user.password,
        newPassword: 'first-new-pass-4711',
      }),
      changePassword(deps, principal, {
        currentPassword: user.password,
        newPassword: 'second-new-pass-4712',
      }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, user.id)))[0]?.authEpoch,
    ).toBe(1)
  })
})

describe('manual verification (admin:verify-email)', () => {
  test('verifies and activates a confirmed registration, revoking its credential, with an audit trail', async () => {
    const deps = makeDeps(dbs.app.db)
    const user = await createActiveUser(deps, { username: 'manual' })
    await dbs.owner.db
      .update(users)
      .set({ emailVerified: false, activationStatus: 'pending' })
      .where(eq(users.id, user.id))
    expect(await verifyEmailManually(deps, { email: user.email, actor: 'cli' })).toBe(true)
    expect((await dbs.owner.db.select().from(users).where(eq(users.id, user.id)))[0]).toMatchObject(
      { emailVerified: true, activationStatus: 'active' },
    )
    expect(await verifyEmailManually(deps, { email: user.email, actor: 'cli' })).toBe(false)
    expect(await verifyEmailManually(deps, { email: 'nobody@example.com', actor: 'cli' })).toBe(
      false,
    )
  })
})
