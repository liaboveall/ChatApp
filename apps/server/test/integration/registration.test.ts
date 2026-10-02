import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { AppError } from '@chatapp/contracts'
import {
  accounts,
  auditLogs,
  authChallenges,
  idempotencyRecords,
  registrationInvites,
  registrationInviteUses,
  users,
  workItems,
} from '@chatapp/db'
import { eq, sql } from 'drizzle-orm'
import { consumeVerification, requestVerification } from '../../src/domain/credentials.ts'
import { createInvite } from '../../src/domain/invites.ts'
import {
  type RegisterInput,
  reconcileRegistrations,
  registerAccount,
  revokeRegistration,
} from '../../src/domain/registration.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import {
  createActiveUser,
  injectInsertFailure,
  makeDeps,
  makePrincipal,
  readLiveToken,
} from '../support/deps.ts'

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

const PASSWORD = 'tomato-umbrella-47-lantern'

let counter = 0
function input(code: string, overrides: Partial<RegisterInput> = {}): RegisterInput {
  counter += 1
  return {
    email: `member${counter}@example.com`,
    username: `member${counter}`,
    displayName: `Member ${counter}`,
    password: PASSWORD,
    inviteCode: code,
    idempotencyKey: `key-${counter}-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  }
}

async function setup(role: 'user' | 'admin' = 'admin') {
  const deps = makeDeps(dbs.app.db)
  const inviter = await createActiveUser(deps, { username: 'inviter', role })
  const principal = await makePrincipal(deps, inviter)
  const invite = await createInvite(deps, principal, {})
  return { deps, inviter, principal, invite, code: invite.code }
}

async function failureOf(run: () => Promise<unknown>): Promise<AppError | Error | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return error as Error
  }
}

describe('registerAccount: the happy path', () => {
  test('creates a pending account, its registration, a credential and an email work item in one go', async () => {
    const { deps, code, inviter } = await setup()
    const request = input(code)
    const result = await registerAccount(deps, { ...request, requestId: 'req-1' })
    expect(result).toEqual({ status: 'verification_required' })

    const [user] = await dbs.owner.db.select().from(users).where(eq(users.email, request.email))
    expect(user).toMatchObject({
      username: request.username,
      name: request.displayName,
      activationStatus: 'pending',
      emailVerified: false,
      accountSource: 'registration',
      invitedById: inviter.id,
    })
    const [registration] = await dbs.owner.db.select().from(registrationInviteUses)
    expect(registration).toMatchObject({
      status: 'confirmed',
      userId: user?.id,
      inviterId: inviter.id,
    })
    expect(user?.registrationId).toBe(registration?.id)

    const [credential] = await dbs.owner.db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, user?.id ?? ''))
    expect(credential?.providerId).toBe('credential')
    expect(await deps.passwords.verify(credential?.password ?? '', PASSWORD)).toBe(true)

    const [invite] = await dbs.owner.db.select().from(registrationInvites)
    expect(invite?.useCount).toBe(1)
    const [owner] = await dbs.owner.db.select().from(users).where(eq(users.id, inviter.id))
    expect(owner?.invitesUsed).toBe(1)

    const [challenge] = await dbs.owner.db.select().from(authChallenges)
    expect(challenge).toMatchObject({
      userId: user?.id,
      purpose: 'verify_email',
      registrationId: registration?.id,
    })
    expect(challenge?.deliveryCiphertext).toBeTruthy()
    const [work] = await dbs.owner.db.select().from(workItems)
    expect(work).toMatchObject({ kind: 'email', status: 'pending', entityId: challenge?.id })
    // No secret or personal data in the work payload or the audit trail.
    expect(JSON.stringify(work?.payload)).not.toContain('@')
    const audit = await dbs.owner.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'auth.registered'))
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit[0])).not.toContain(request.email)
  })

  test('the email is stored lower-cased and the invite code tolerates formatting', async () => {
    const { deps, code } = await setup()
    const request = input(code.toLowerCase().replaceAll('-', ' '), {
      email: 'Mixed.Case@Example.COM',
    })
    await registerAccount(deps, request)
    const [user] = await dbs.owner.db
      .select()
      .from(users)
      .where(eq(users.username, request.username))
    expect(user?.email).toBe('mixed.case@example.com')
  })
})

describe('registerAccount: refusals leave no trace', () => {
  async function untouched() {
    expect(await dbs.owner.db.select().from(registrationInviteUses)).toHaveLength(0)
    expect(await dbs.owner.db.select().from(authChallenges)).toHaveLength(0)
    expect(await dbs.owner.db.select().from(idempotencyRecords)).toHaveLength(0)
    const [invite] = await dbs.owner.db.select().from(registrationInvites)
    expect(invite?.useCount).toBe(0)
  }

  test('unknown, malformed, revoked and expired invitations are one and the same error', async () => {
    const { deps, code, invite, principal } = await setup()
    const unknown = await failureOf(() => registerAccount(deps, input('AAAAAAAAAAAAAAAA')))
    const malformed = await failureOf(() => registerAccount(deps, input('nope')))
    expect((unknown as AppError).code).toBe('INVITE_INVALID')
    expect((malformed as AppError).code).toBe('INVITE_INVALID')

    deps.clock.advance(8 * 86_400_000)
    expect(((await failureOf(() => registerAccount(deps, input(code)))) as AppError).code).toBe(
      'INVITE_INVALID',
    )
    deps.clock.advance(-8 * 86_400_000)

    await dbs.owner.db
      .update(registrationInvites)
      .set({ revokedAt: new Date() })
      .where(eq(registrationInvites.id, invite.id))
    expect(((await failureOf(() => registerAccount(deps, input(code)))) as AppError).code).toBe(
      'INVITE_INVALID',
    )
    void principal
    await untouched()
  })

  test('reserved names and weak passwords are validation errors', async () => {
    const { deps, code } = await setup()
    const reserved = await failureOf(() =>
      registerAccount(deps, input(code, { username: 'admin' })),
    )
    expect((reserved as AppError).details).toMatchObject({ field: 'username', reason: 'reserved' })
    const name = await failureOf(() =>
      registerAccount(deps, input(code, { displayName: '管理员' })),
    )
    expect((name as AppError).details).toMatchObject({ field: 'name', reason: 'reserved' })
    const weak = await failureOf(() =>
      registerAccount(deps, input(code, { password: 'password123' })),
    )
    expect((weak as AppError).details).toMatchObject({ field: 'password' })
    await untouched()
  })

  test('a taken username is a conflict and does not consume the slot', async () => {
    const { deps, code } = await setup()
    await createActiveUser(deps, { username: 'taken' })
    const error = await failureOf(() => registerAccount(deps, input(code, { username: 'taken' })))
    expect((error as AppError).code).toBe('CONFLICT')
    await untouched()
  })

  test('an email that already has an account gets the same answer, creates nothing and keeps the slot', async () => {
    const { deps, code } = await setup()
    const existing = await createActiveUser(deps, { username: 'existing' })
    const before = await dbs.owner.db.select().from(users)
    const result = await registerAccount(deps, input(code, { email: existing.email.toUpperCase() }))
    expect(result).toEqual({ status: 'verification_required' })
    expect(await dbs.owner.db.select().from(users)).toHaveLength(before.length)
    await untouched()
    expect(await dbs.owner.db.select().from(workItems)).toHaveLength(0)
  })
})

describe('registerAccount: idempotency (D-066)', () => {
  test('the same key and request replays without side effects; another request with the key is a 409', async () => {
    const { deps, code } = await setup()
    const request = input(code)
    await registerAccount(deps, request)
    expect(await registerAccount(deps, request)).toEqual({ status: 'verification_required' })
    expect(
      await dbs.owner.db.select().from(users).where(eq(users.email, request.email)),
    ).toHaveLength(1)
    expect((await dbs.owner.db.select().from(registrationInvites))[0]?.useCount).toBe(1)
    expect(await dbs.owner.db.select().from(workItems)).toHaveLength(1)

    const other = await failureOf(() =>
      registerAccount(deps, { ...request, username: 'someoneelse' }),
    )
    expect((other as AppError).code).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('malformed keys are rejected', async () => {
    const { deps, code } = await setup()
    for (const key of ['', 'has space', 'x'.repeat(129)]) {
      const error = await failureOf(() =>
        registerAccount(deps, input(code, { idempotencyKey: key })),
      )
      expect((error as AppError).code).toBe('VALIDATION_FAILED')
    }
  })
})

describe('registerAccount: slots under concurrency (INV-14)', () => {
  test('a single-use code registers exactly one of several simultaneous people', async () => {
    const { deps, code } = await setup()
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => registerAccount(deps, input(code))),
    )
    const ok = results.filter((r) => r.status === 'fulfilled')
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(refused).toHaveLength(5)
    for (const r of refused) expect((r.reason as AppError).code).toBe('INVITE_INVALID')
    expect((await dbs.owner.db.select().from(registrationInvites))[0]?.useCount).toBe(1)
    expect(await dbs.owner.db.select().from(registrationInviteUses)).toHaveLength(1)
  })

  test('a member with a quota of two can bring in two people, never three', async () => {
    const deps = makeDeps(dbs.app.db)
    const inviter = await createActiveUser(deps, { username: 'member' })
    await dbs.owner.db.update(users).set({ inviteQuota: 2 }).where(eq(users.id, inviter.id))
    const principal = await makePrincipal(deps, inviter)
    const first = await createInvite(deps, principal, { maxUses: 5 })
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => registerAccount(deps, input(first.code))),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    const [row] = await dbs.owner.db.select().from(users).where(eq(users.id, inviter.id))
    expect(row?.invitesUsed).toBe(2)
    expect((await dbs.owner.db.select().from(registrationInvites))[0]?.useCount).toBe(2)
  })

  test('two codes racing for the same email create one account and consume one slot in total', async () => {
    const deps = makeDeps(dbs.app.db)
    const inviter = await createActiveUser(deps, { username: 'boss', role: 'admin' })
    const principal = await makePrincipal(deps, inviter)
    const a = await createInvite(deps, principal, {})
    const b = await createInvite(deps, principal, {})
    const email = 'race@example.com'
    const results = await Promise.all([
      registerAccount(deps, input(a.code, { email, username: 'racer1' })),
      registerAccount(deps, input(b.code, { email, username: 'racer2' })),
    ])
    expect(results.every((r) => r.status === 'verification_required')).toBe(true)
    expect(await dbs.owner.db.select().from(users).where(eq(users.email, email))).toHaveLength(1)
    const used = await dbs.owner.db
      .select({ n: sql<number>`coalesce(sum(${registrationInvites.useCount}), 0)::int` })
      .from(registrationInvites)
    expect(used[0]?.n).toBe(1)
    expect(await dbs.owner.db.select().from(registrationInviteUses)).toHaveLength(1)
  })
})

describe('AT-05: a failure at any step undoes the whole registration', () => {
  for (const table of [
    'registration_invite_uses',
    'accounts',
    'auth_challenges',
    'work_items',
    'audit_logs',
  ]) {
    test(`failing the insert into ${table} rolls everything back`, async () => {
      const { deps, code, inviter } = await setup()
      const baseline = {
        users: (await dbs.owner.db.select().from(users)).length,
        audits: (await dbs.owner.db.select().from(auditLogs)).length,
        works: (await dbs.owner.db.select().from(workItems)).length,
      }
      const remove = await injectInsertFailure(dbs.owner.db, table)
      try {
        await expect(registerAccount(deps, input(code))).rejects.toThrow()
      } finally {
        await remove()
      }
      expect(await dbs.owner.db.select().from(users)).toHaveLength(baseline.users)
      expect(await dbs.owner.db.select().from(registrationInviteUses)).toHaveLength(0)
      expect(await dbs.owner.db.select().from(authChallenges)).toHaveLength(0)
      expect(await dbs.owner.db.select().from(idempotencyRecords)).toHaveLength(0)
      expect(await dbs.owner.db.select().from(workItems)).toHaveLength(baseline.works)
      expect((await dbs.owner.db.select().from(registrationInvites))[0]?.useCount).toBe(0)
      expect(
        (await dbs.owner.db.select().from(users).where(eq(users.id, inviter.id)))[0]?.invitesUsed,
      ).toBe(0)
      // And the very same request still works once the fault is gone.
      expect(await registerAccount(deps, input(code))).toEqual({ status: 'verification_required' })
    })
  }
})

describe('email verification (D-076, AT-25)', () => {
  async function registered() {
    const ctx = await setup()
    const request = input(ctx.code)
    await registerAccount(ctx.deps, request)
    const [user] = await dbs.owner.db.select().from(users).where(eq(users.email, request.email))
    if (!user) throw new Error('no user')
    return { ...ctx, request, user }
  }

  test('consuming the credential verifies and activates in one step, and only once', async () => {
    const { deps, user } = await registered()
    const token = await readLiveToken(deps, user.id, 'verify_email')
    await consumeVerification(deps, { token })
    const [after] = await dbs.owner.db.select().from(users).where(eq(users.id, user.id))
    expect(after).toMatchObject({ emailVerified: true, activationStatus: 'active' })
    const [challenge] = await dbs.owner.db.select().from(authChallenges)
    expect(challenge?.consumedAt).not.toBeNull()
    expect(challenge?.deliveryCiphertext).toBeNull()
    const again = await failureOf(() => consumeVerification(deps, { token }))
    expect((again as AppError).code).toBe('AUTH_CHALLENGE_INVALID')
  })

  test('an expired credential and a made-up token are the same generic failure', async () => {
    const { deps, user } = await registered()
    const token = await readLiveToken(deps, user.id, 'verify_email')
    deps.clock.advance(61 * 60_000)
    expect(((await failureOf(() => consumeVerification(deps, { token }))) as AppError).code).toBe(
      'AUTH_CHALLENGE_INVALID',
    )
    const bogus = 'A'.repeat(43)
    expect(
      ((await failureOf(() => consumeVerification(deps, { token: bogus }))) as AppError).code,
    ).toBe('AUTH_CHALLENGE_INVALID')
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, user.id)))[0]?.emailVerified,
    ).toBe(false)
  })

  test('resending revokes the previous link', async () => {
    const { deps, user, request } = await registered()
    const first = await readLiveToken(deps, user.id, 'verify_email')
    await requestVerification(deps, { email: request.email })
    const second = await readLiveToken(deps, user.id, 'verify_email')
    expect(second).not.toBe(first)
    expect(
      ((await failureOf(() => consumeVerification(deps, { token: first }))) as AppError).code,
    ).toBe('AUTH_CHALLENGE_INVALID')
    await consumeVerification(deps, { token: second })
  })

  test('a link cannot activate the account of a later registration with the same email', async () => {
    const { deps, user, request, principal, code } = await registered()
    const oldToken = await readLiveToken(deps, user.id, 'verify_email')
    const [registration] = await dbs.owner.db.select().from(registrationInviteUses)
    await revokeRegistration(deps, principal, registration?.id ?? '')
    expect(
      await dbs.owner.db.select().from(users).where(eq(users.email, request.email)),
    ).toHaveLength(0)

    // The invitation slot came back, so the same person can register again.
    const next = await createInvite(deps, principal, {})
    await registerAccount(deps, { ...request, inviteCode: next.code, idempotencyKey: 'again-1' })
    const [rebuilt] = await dbs.owner.db.select().from(users).where(eq(users.email, request.email))
    expect(rebuilt?.id).not.toBe(user.id)
    expect(
      ((await failureOf(() => consumeVerification(deps, { token: oldToken }))) as AppError).code,
    ).toBe('AUTH_CHALLENGE_INVALID')
    expect(
      (
        await dbs.owner.db
          .select()
          .from(users)
          .where(eq(users.id, rebuilt?.id ?? ''))
      )[0]?.emailVerified,
    ).toBe(false)
    void code
  })

  test('a credential issued before a disaster-restore generation change is refused', async () => {
    const { deps, user } = await registered()
    const token = await readLiveToken(deps, user.id, 'verify_email')
    const restored = {
      ...deps,
      config: { ...deps.config, auth: { ...deps.config.auth, restoreEpoch: 'after-restore' } },
    }
    expect(
      ((await failureOf(() => consumeVerification(restored, { token }))) as AppError).code,
    ).toBe('AUTH_CHALLENGE_INVALID')
  })

  test('concurrent consumption activates once', async () => {
    const { deps, user } = await registered()
    const token = await readLiveToken(deps, user.id, 'verify_email')
    const results = await Promise.allSettled([
      consumeVerification(deps, { token }),
      consumeVerification(deps, { token }),
      consumeVerification(deps, { token }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, user.id)))[0]?.activationStatus,
    ).toBe('active')
  })

  test('requesting verification for unknown, active or unconfirmed accounts does nothing and says nothing', async () => {
    const { deps } = await setup()
    const active = await createActiveUser(deps, { username: 'already' })
    const before = (await dbs.owner.db.select().from(authChallenges)).length
    await requestVerification(deps, { email: 'nobody@example.com' })
    await requestVerification(deps, { email: active.email })
    expect(await dbs.owner.db.select().from(authChallenges)).toHaveLength(before)
  })
})

describe('AT-05: verification and withdrawal race', () => {
  test('exactly one of them wins, and the slot accounting matches the winner', async () => {
    for (let round = 0; round < 8; round += 1) {
      await truncateAll(dbs.owner)
      const { deps, code, inviter, principal } = await setup()
      const request = input(code)
      await registerAccount(deps, request)
      const [user] = await dbs.owner.db.select().from(users).where(eq(users.email, request.email))
      const [registration] = await dbs.owner.db.select().from(registrationInviteUses)
      const token = await readLiveToken(deps, user?.id ?? '', 'verify_email')

      const [verify, withdraw] = await Promise.allSettled([
        consumeVerification(deps, { token }),
        revokeRegistration(deps, principal, registration?.id ?? ''),
      ])
      const [owner] = await dbs.owner.db.select().from(users).where(eq(users.id, inviter.id))
      const [invite] = await dbs.owner.db.select().from(registrationInvites)
      const [after] = await dbs.owner.db.select().from(registrationInviteUses)
      const accounts_ = await dbs.owner.db
        .select()
        .from(users)
        .where(eq(users.email, request.email))

      if (verify.status === 'fulfilled') {
        // Activated first: the withdrawal must have been refused and nothing was refunded.
        expect(withdraw.status).toBe('rejected')
        expect(accounts_[0]).toMatchObject({ activationStatus: 'active', emailVerified: true })
        expect(after?.status).toBe('confirmed')
        expect([invite?.useCount, owner?.invitesUsed]).toEqual([1, 1])
      } else {
        // Withdrawn first: the credential died with the account, the slot came back exactly once.
        expect(withdraw.status).toBe('fulfilled')
        expect(((verify as PromiseRejectedResult).reason as AppError).code).toBe(
          'AUTH_CHALLENGE_INVALID',
        )
        expect(accounts_).toHaveLength(0)
        expect(after?.status).toBe('released')
        expect([invite?.useCount, owner?.invitesUsed]).toEqual([0, 0])
        expect(await dbs.owner.db.select().from(authChallenges)).toHaveLength(0)
      }
    }
  })
})

describe('registration cleanup and recovery (D-059 rules 4-6)', () => {
  async function stuckRegistration(status: 'reserved' | 'account_created', withAccount: boolean) {
    const ctx = await setup()
    const [invite] = await dbs.owner.db.select().from(registrationInvites)
    await dbs.owner.db
      .update(registrationInvites)
      .set({ useCount: 1 })
      .where(eq(registrationInvites.id, invite?.id ?? ''))
    await dbs.owner.db.update(users).set({ invitesUsed: 1 }).where(eq(users.id, ctx.inviter.id))
    const registrationId = ctx.deps.newId()
    await dbs.owner.db.insert(registrationInviteUses).values({
      id: registrationId,
      inviteId: invite?.id ?? '',
      inviterId: ctx.inviter.id,
      emailNormalized: 'stuck@example.com',
      status,
      expiresAt: new Date(ctx.deps.clock.now().getTime() + 600_000),
    })
    let accountId: string | undefined
    if (withAccount) {
      const [row] = await dbs.owner.db
        .insert(users)
        .values({
          name: 'Stuck',
          email: 'stuck@example.com',
          username: 'stuck',
          accountSource: 'registration',
          registrationId,
        })
        .returning({ id: users.id })
      accountId = row?.id
    }
    ctx.deps.clock.advance(11 * 60_000)
    return { ...ctx, registrationId, accountId }
  }

  test('a reserved registration with no account is released and its slot refunded once', async () => {
    const { deps, inviter, registrationId } = await stuckRegistration('reserved', false)
    expect(await reconcileRegistrations(deps)).toMatchObject({ released: 1 })
    expect(await reconcileRegistrations(deps)).toMatchObject({ released: 0 })
    const [row] = await dbs.owner.db
      .select()
      .from(registrationInviteUses)
      .where(eq(registrationInviteUses.id, registrationId))
    expect(row).toMatchObject({ status: 'released', emailNormalized: null, requestHash: null })
    expect((await dbs.owner.db.select().from(registrationInvites))[0]?.useCount).toBe(0)
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, inviter.id)))[0]?.invitesUsed,
    ).toBe(0)
  })

  test('a reserved registration whose account exists is completed instead of refunded', async () => {
    const { deps, inviter, registrationId, accountId } = await stuckRegistration('reserved', true)
    expect(await reconcileRegistrations(deps)).toMatchObject({ completed: 1, released: 0 })
    const [row] = await dbs.owner.db
      .select()
      .from(registrationInviteUses)
      .where(eq(registrationInviteUses.id, registrationId))
    expect(row).toMatchObject({ status: 'confirmed', userId: accountId })
    expect((await dbs.owner.db.select().from(registrationInvites))[0]?.useCount).toBe(1)
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, inviter.id)))[0]?.invitesUsed,
    ).toBe(1)
    const [challenge] = await dbs.owner.db.select().from(authChallenges)
    expect(challenge).toMatchObject({ userId: accountId, purpose: 'verify_email' })
    // Running it again must not issue a second credential.
    await reconcileRegistrations(deps)
    expect(await dbs.owner.db.select().from(authChallenges)).toHaveLength(1)
  })

  test('an account_created registration is finished the same way', async () => {
    const { deps, registrationId } = await stuckRegistration('account_created', true)
    expect(await reconcileRegistrations(deps)).toMatchObject({ completed: 1 })
    expect(
      (
        await dbs.owner.db
          .select()
          .from(registrationInviteUses)
          .where(eq(registrationInviteUses.id, registrationId))
      )[0]?.status,
    ).toBe('confirmed')
  })

  test('an account still unverified after seven days is deleted and the slot refunded exactly once', async () => {
    const { deps, code, inviter } = await setup()
    const request = input(code)
    await registerAccount(deps, request)
    const [user] = await dbs.owner.db.select().from(users).where(eq(users.email, request.email))
    await dbs.owner.db
      .update(users)
      .set({ createdAt: new Date(deps.clock.now().getTime() - 8 * 86_400_000) })
      .where(eq(users.id, user?.id ?? ''))
    expect(await reconcileRegistrations(deps)).toMatchObject({ purged: 1 })
    expect(await reconcileRegistrations(deps)).toMatchObject({ purged: 0 })
    expect(
      await dbs.owner.db.select().from(users).where(eq(users.email, request.email)),
    ).toHaveLength(0)
    expect(
      await dbs.owner.db
        .select()
        .from(accounts)
        .where(eq(accounts.userId, user?.id ?? '')),
    ).toHaveLength(0)
    expect((await dbs.owner.db.select().from(registrationInvites))[0]?.useCount).toBe(0)
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, inviter.id)))[0]?.invitesUsed,
    ).toBe(0)
  })

  test('a verified account is never swept away, however old', async () => {
    const { deps, code } = await setup()
    const request = input(code)
    await registerAccount(deps, request)
    const [user] = await dbs.owner.db.select().from(users).where(eq(users.email, request.email))
    await consumeVerification(deps, {
      token: await readLiveToken(deps, user?.id ?? '', 'verify_email'),
    })
    await dbs.owner.db
      .update(users)
      .set({ createdAt: new Date(deps.clock.now().getTime() - 30 * 86_400_000) })
      .where(eq(users.id, user?.id ?? ''))
    expect(await reconcileRegistrations(deps)).toMatchObject({ purged: 0, released: 0 })
    expect(
      await dbs.owner.db.select().from(users).where(eq(users.email, request.email)),
    ).toHaveLength(1)
  })

  test('only the inviter or an administrator may withdraw a registration, and not after activation', async () => {
    const { deps, code } = await setup()
    const request = input(code)
    await registerAccount(deps, request)
    const stranger = await createActiveUser(deps, { username: 'stranger' })
    const strangerPrincipal = await makePrincipal(deps, stranger)
    const [registration] = await dbs.owner.db.select().from(registrationInviteUses)
    const denied = await failureOf(() =>
      revokeRegistration(deps, strangerPrincipal, registration?.id ?? ''),
    )
    expect((denied as AppError).code).toBe('NOT_FOUND')

    const [user] = await dbs.owner.db.select().from(users).where(eq(users.email, request.email))
    await consumeVerification(deps, {
      token: await readLiveToken(deps, user?.id ?? '', 'verify_email'),
    })
    const [inviter] = await dbs.owner.db.select().from(users).where(eq(users.username, 'inviter'))
    const inviterPrincipal = await makePrincipal(deps, { id: inviter?.id ?? '' })
    const late = await failureOf(() =>
      revokeRegistration(deps, inviterPrincipal, registration?.id ?? ''),
    )
    expect((late as AppError).code).toBe('CONFLICT')
    expect(
      await dbs.owner.db.select().from(users).where(eq(users.email, request.email)),
    ).toHaveLength(1)
  })
})
