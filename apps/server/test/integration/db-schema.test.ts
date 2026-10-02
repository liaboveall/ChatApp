import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  authChallenges,
  authorizationOrigins,
  registrationInvites,
  registrationInviteUses,
  sessions,
  usernameReservations,
  users,
} from '@chatapp/db'
import { isBootstrapped, runBootstrap } from '@chatapp/db/bootstrap'
import { eq, sql } from 'drizzle-orm'
import { pgErrorInfo } from '../../src/lib/pg-error.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'

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

/** Runs a statement and returns the PostgreSQL error (or undefined) so tests can assert on SQLSTATE and constraint. */
async function failure(
  run: () => Promise<unknown>,
): Promise<{ code?: string; constraint?: string } | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    const info = pgErrorInfo(error)
    return { code: info?.sqlState, constraint: info?.constraint }
  }
}

const cli = (name: string) => ({
  name,
  email: `${name.toLowerCase()}@example.com`,
  username: name.toLowerCase(),
  accountSource: 'cli' as const,
  emailVerified: true,
  activationStatus: 'active' as const,
})

describe('database accounts', () => {
  test('the application role reads and writes rows but cannot change the schema', async () => {
    await dbs.app.db.insert(users).values(cli('Alice'))
    expect(await dbs.app.db.select({ n: users.name }).from(users)).toEqual([{ n: 'Alice' }])

    expect((await failure(() => dbs.app.db.execute(sql`create table sneaky (id int)`)))?.code).toBe(
      '42501',
    )
    expect((await failure(() => dbs.app.db.execute(sql`truncate table users cascade`)))?.code).toBe(
      '42501',
    )
    expect(
      (await failure(() => dbs.app.db.execute(sql`alter table users add column x int`)))?.code,
    ).toBe('42501')
    expect((await failure(() => dbs.app.db.execute(sql`create role r2 login`)))?.code).toBe('42501')
  })

  test('the application role is not a superuser and cannot read migration history', async () => {
    const rows = await dbs.app.db.execute<{
      rolsuper: boolean
      rolcreatedb: boolean
      rolcreaterole: boolean
    }>(sql`select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = current_user`)
    expect(rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false })
    expect(
      (await failure(() => dbs.app.db.execute(sql`select * from drizzle.__drizzle_migrations`)))
        ?.code,
    ).toBe('42501')
  })

  test('primary keys default to UUIDv7 (V-04 database side)', async () => {
    const [row] = await dbs.app.db.insert(users).values(cli('Bob')).returning({ id: users.id })
    // Version nibble is the first hex digit of the third group.
    expect(row?.id.split('-')[2]?.[0]).toBe('7')
  })
})

describe('users constraints', () => {
  test('email must be lower case and username must match the format', async () => {
    expect(
      (
        await failure(() =>
          dbs.app.db.insert(users).values({ ...cli('Carol'), email: 'Carol@Example.com' }),
        )
      )?.constraint,
    ).toBe('users_email_lower')
    expect(
      (await failure(() => dbs.app.db.insert(users).values({ ...cli('Carol'), username: 'Carol' })))
        ?.constraint,
    ).toBe('users_username_format')
    expect(
      (await failure(() => dbs.app.db.insert(users).values({ ...cli('Carol'), username: 'ab' })))
        ?.constraint,
    ).toBe('users_username_format')
  })

  test('email and username are unique under stable constraint names', async () => {
    await dbs.app.db.insert(users).values(cli('Dave'))
    expect(
      (
        await failure(() =>
          dbs.app.db.insert(users).values({ ...cli('Other'), email: 'dave@example.com' }),
        )
      )?.constraint,
    ).toBe('users_email_unique')
    expect(
      (await failure(() => dbs.app.db.insert(users).values({ ...cli('Other'), username: 'dave' })))
        ?.constraint,
    ).toBe('users_username_unique')
  })

  test('an active account needs a verified email (INV-18)', async () => {
    const err = await failure(() =>
      dbs.app.db.insert(users).values({ ...cli('Erin'), emailVerified: false }),
    )
    expect(err?.constraint).toBe('users_active_needs_verified_email')
  })

  test('only registration accounts carry a registration_id, from the first INSERT', async () => {
    const noLink = await failure(() =>
      dbs.app.db.insert(users).values({ ...cli('Frank'), accountSource: 'registration' }),
    )
    expect(noLink?.constraint).toBe('users_registration_link')
  })

  test('non-admin invites_used cannot exceed the quota (INV-14)', async () => {
    const err = await failure(() =>
      dbs.app.db.insert(users).values({ ...cli('Gina'), inviteQuota: 1, invitesUsed: 2 }),
    )
    expect(err?.constraint).toBe('users_invites_used_range')
    await dbs.app.db
      .insert(users)
      .values({ ...cli('Hank'), role: 'admin', inviteQuota: 1, invitesUsed: 2 })
  })
})

describe('registration and invitation constraints', () => {
  async function inviter() {
    const [row] = await dbs.app.db.insert(users).values(cli('Inviter')).returning({ id: users.id })
    if (!row) throw new Error('no inviter')
    return row.id
  }

  test('use_count never exceeds max_uses', async () => {
    const createdBy = await inviter()
    const base = { codeHash: 'h1', createdBy, expiresAt: new Date(Date.now() + 1000) }
    expect(
      (
        await failure(() =>
          dbs.app.db.insert(registrationInvites).values({ ...base, maxUses: 1, useCount: 2 }),
        )
      )?.constraint,
    ).toBe('invites_use_count_range')
    await dbs.app.db
      .insert(registrationInvites)
      .values({ ...base, codeHash: 'h2', maxUses: null, useCount: 50 })
  })

  test('a registration is linked to its account in both directions, one-to-one', async () => {
    const inviterId = await inviter()
    const [invite] = await dbs.app.db
      .insert(registrationInvites)
      .values({
        codeHash: 'h',
        createdBy: inviterId,
        maxUses: 1,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: registrationInvites.id })
    const [reg] = await dbs.app.db
      .insert(registrationInviteUses)
      .values({
        inviteId: invite?.id ?? '',
        inviterId,
        emailNormalized: 'new@example.com',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: registrationInviteUses.id })
    const registrationId = reg?.id ?? ''
    const [account] = await dbs.app.db
      .insert(users)
      .values({
        name: 'New',
        email: 'new@example.com',
        username: 'newuser',
        registrationId,
        activationStatus: 'pending',
        invitedById: inviterId,
      })
      .returning({ id: users.id })
    await dbs.app.db
      .update(registrationInviteUses)
      .set({ userId: account?.id ?? '', status: 'confirmed' })
      .where(eq(registrationInviteUses.id, registrationId))

    // A second account cannot claim the same registration.
    const dup = await failure(() =>
      dbs.app.db
        .insert(users)
        .values({ name: 'Dup', email: 'dup@example.com', username: 'dupuser', registrationId }),
    )
    expect(dup?.constraint).toBe('users_registration_id_unique')
  })

  test('only one live credential per user and purpose', async () => {
    const userId = await inviter()
    const live = {
      userId,
      purpose: 'verify_email' as const,
      emailHash: 'e',
      authEpoch: 0,
      restoreEpoch: 'r',
      expiresAt: new Date(Date.now() + 60_000),
    }
    await dbs.app.db.insert(authChallenges).values({ ...live, tokenHash: 't1' })
    expect(
      (await failure(() => dbs.app.db.insert(authChallenges).values({ ...live, tokenHash: 't2' })))
        ?.constraint,
    ).toBe('challenges_one_live_uidx')
    // Revoking the first makes room for a resend.
    await dbs.app.db
      .update(authChallenges)
      .set({ revokedAt: new Date() })
      .where(eq(authChallenges.tokenHash, 't1'))
    await dbs.app.db.insert(authChallenges).values({ ...live, tokenHash: 't3' })
  })

  test('delivery columns are all set or all empty', async () => {
    const userId = await inviter()
    const err = await failure(() =>
      dbs.app.db.insert(authChallenges).values({
        userId,
        purpose: 'reset_password',
        emailHash: 'e',
        authEpoch: 0,
        restoreEpoch: 'r',
        tokenHash: 'tx',
        expiresAt: new Date(Date.now() + 1000),
        deliveryCiphertext: 'c',
      }),
    )
    expect(err?.constraint).toBe('challenges_delivery_all_or_none')
  })
})

describe('origins and sessions', () => {
  test('origin revocation needs a reason and vice versa', async () => {
    const [user] = await dbs.app.db.insert(users).values(cli('Ivy')).returning({ id: users.id })
    const userId = user?.id ?? ''
    expect(
      (
        await failure(() =>
          dbs.app.db
            .insert(authorizationOrigins)
            .values({ userId, restoreEpoch: 'r', revokedAt: new Date() }),
        )
      )?.constraint,
    ).toBe('origins_revoke_pair')
    await dbs.app.db
      .insert(authorizationOrigins)
      .values({ userId, restoreEpoch: 'r', revokedAt: new Date(), revokeReason: 'device_revoked' })
  })

  test('deleting an account removes its sessions and origins without foreign key errors', async () => {
    const [user] = await dbs.app.db.insert(users).values(cli('Jack')).returning({ id: users.id })
    const userId = user?.id ?? ''
    const [origin] = await dbs.app.db
      .insert(authorizationOrigins)
      .values({ userId, restoreEpoch: 'r' })
      .returning({ id: authorizationOrigins.id })
    await dbs.app.db.insert(sessions).values({
      userId,
      token: 'tok',
      expiresAt: new Date(Date.now() + 1000),
      authEpoch: 0,
      authorizationOriginId: origin?.id ?? '',
    })
    await dbs.app.db.delete(users).where(eq(users.id, userId))
    expect(await dbs.app.db.select().from(sessions)).toHaveLength(0)
    expect(await dbs.app.db.select().from(authorizationOrigins)).toHaveLength(0)
  })
})

describe('bootstrap (docs/04 section 9)', () => {
  const options = { agentUsername: 'assistant', agentDisplayName: '助手', productName: 'ChatApp' }

  test('creates the non-login agent and reserved names, and is idempotent', async () => {
    expect(await isBootstrapped(dbs.owner.db)).toBe(false)
    const first = await runBootstrap(dbs.owner.db, options)
    const second = await runBootstrap(dbs.owner.db, options)
    expect(first.agentCreated).toBe(true)
    expect(second.agentCreated).toBe(false)
    expect(second.agentUserId).toBe(first.agentUserId)
    expect(await isBootstrapped(dbs.owner.db)).toBe(true)

    const agents = await dbs.owner.db.select().from(users).where(eq(users.isBot, true))
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      username: 'assistant',
      name: '助手',
      accountSource: 'bootstrap',
      activationStatus: 'active',
    })
    // No credential, no session, no demo users.
    const accounts = await dbs.owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from accounts`,
    )
    expect(accounts[0]?.n).toBe(0)
    expect(await dbs.owner.db.select().from(users)).toHaveLength(1)

    const reserved = await dbs.owner.db
      .select({ u: usernameReservations.username })
      .from(usernameReservations)
    expect(reserved.map((row) => row.u)).toContain('admin')
    expect(reserved.map((row) => row.u)).toContain('chatapp')
  })

  test('refuses to adopt a human account that holds the agent username', async () => {
    await dbs.owner.db.insert(users).values(cli('Assistant'))
    await expect(runBootstrap(dbs.owner.db, options)).rejects.toThrow('belongs to a human account')
  })

  test('updates the display name and bumps the profile version when configuration changes', async () => {
    await runBootstrap(dbs.owner.db, options)
    await runBootstrap(dbs.owner.db, { ...options, agentDisplayName: '小助手' })
    const [agent] = await dbs.owner.db.select().from(users).where(eq(users.isBot, true))
    expect(agent).toMatchObject({ name: '小助手', profileVersion: 2, meVersion: 2 })
  })
})
