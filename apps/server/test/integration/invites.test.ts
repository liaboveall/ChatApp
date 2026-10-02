import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { type AppError, LIMITS } from '@chatapp/contracts'
import { registrationInvites, users } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { checkInvite, createInvite, listInvites, revokeInvite } from '../../src/domain/invites.ts'
import { registerAccount } from '../../src/domain/registration.ts'
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

async function failureOf(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run()
  } catch (error) {
    return error as AppError
  }
  throw new Error('expected a failure')
}

async function member(username: string, role: 'user' | 'admin' = 'user') {
  const deps = makeDeps(dbs.app.db)
  const user = await createActiveUser(deps, { username, role })
  return { deps, user, principal: await makePrincipal(deps, user) }
}

describe('creating invitations', () => {
  test('returns the plaintext once, stores only its hash, and defaults to 7 days and one use', async () => {
    const { deps, principal } = await member('maker')
    const created = await createInvite(deps, principal, { note: 'for Wang' })
    expect(created.code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/)
    expect(created).toMatchObject({ note: 'for Wang', maxUses: 1, useCount: 0, revokedAt: null })
    const days = (new Date(created.expiresAt).getTime() - deps.clock.now().getTime()) / 86_400_000
    expect(days).toBeGreaterThan(6.99)
    expect(days).toBeLessThan(7.01)
    const [row] = await dbs.owner.db.select().from(registrationInvites)
    expect(JSON.stringify(row)).not.toContain(created.code.replaceAll('-', ''))
    expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/)
    // Listing never shows the plaintext either.
    const listed = await listInvites(deps, principal)
    expect(JSON.stringify(listed)).not.toContain(created.code.replaceAll('-', ''))
    expect(listed.invites).toHaveLength(1)
  })

  test('only administrators can make unlimited codes; members are capped on live codes', async () => {
    const { deps, principal } = await member('plain')
    expect((await failureOf(() => createInvite(deps, principal, { maxUses: null }))).code).toBe(
      'FORBIDDEN',
    )
    for (let i = 0; i < LIMITS.maxLiveInvitesPerMember; i += 1)
      await createInvite(deps, principal, {})
    expect((await failureOf(() => createInvite(deps, principal, {}))).code).toBe('QUOTA_EXCEEDED')

    const admin = await member('boss', 'admin')
    const unlimited = await createInvite(admin.deps, admin.principal, { maxUses: null })
    expect(unlimited.maxUses).toBeNull()
  })

  test('a revoked session cannot create invitations', async () => {
    const { deps, principal, user } = await member('gone')
    await dbs.owner.db.update(users).set({ authEpoch: 5 }).where(eq(users.id, user.id))
    expect((await failureOf(() => createInvite(deps, principal, {}))).code).toBe('UNAUTHENTICATED')
    expect(await dbs.owner.db.select().from(registrationInvites)).toHaveLength(0)
  })
})

describe('checking an invitation', () => {
  test('accepts a usable code and rejects every other state with the same error', async () => {
    const { deps, principal } = await member('checker')
    const created = await createInvite(deps, principal, {})
    await checkInvite(deps, created.code)
    await checkInvite(deps, created.code.toLowerCase())

    expect((await failureOf(() => checkInvite(deps, 'AAAA-AAAA-AAAA-AAAA'))).code).toBe(
      'INVITE_INVALID',
    )
    expect((await failureOf(() => checkInvite(deps, 'garbage'))).code).toBe('INVITE_INVALID')

    await revokeInvite(deps, principal, created.id)
    expect((await failureOf(() => checkInvite(deps, created.code))).code).toBe('INVITE_INVALID')
  })

  test('expired, used-up and inviter-out-of-quota codes are unusable', async () => {
    const { deps, principal, user } = await member('limits')
    const expired = await createInvite(deps, principal, { expiresInDays: 1 })
    deps.clock.advance(2 * 86_400_000)
    expect((await failureOf(() => checkInvite(deps, expired.code))).code).toBe('INVITE_INVALID')
    deps.clock.advance(-2 * 86_400_000)

    const spent = await createInvite(deps, principal, {})
    await registerAccount(deps, {
      email: 'new1@example.com',
      username: 'newone',
      displayName: 'New One',
      password: 'tomato-umbrella-47-lantern',
      inviteCode: spent.code,
      idempotencyKey: 'k1',
    })
    expect((await failureOf(() => checkInvite(deps, spent.code))).code).toBe('INVITE_INVALID')

    const fresh = await createInvite(deps, principal, {})
    await dbs.owner.db.update(users).set({ inviteQuota: 1 }).where(eq(users.id, user.id))
    expect((await failureOf(() => checkInvite(deps, fresh.code))).code).toBe('INVITE_INVALID')
  })
})

describe('revoking and listing', () => {
  test('only the creator or an administrator can revoke; revoking twice is fine', async () => {
    const owner = await member('owner1')
    const other = await member('other1')
    const created = await createInvite(owner.deps, owner.principal, {})
    expect(
      (await failureOf(() => revokeInvite(other.deps, other.principal, created.id))).code,
    ).toBe('NOT_FOUND')
    expect(
      (await failureOf(() => revokeInvite(owner.deps, owner.principal, owner.deps.newId()))).code,
    ).toBe('NOT_FOUND')
    await revokeInvite(owner.deps, owner.principal, created.id)
    await revokeInvite(owner.deps, owner.principal, created.id)

    const admin = await member('admin1', 'admin')
    const second = await createInvite(owner.deps, owner.principal, {})
    await revokeInvite(admin.deps, admin.principal, second.id)
    const rows = await dbs.owner.db.select().from(registrationInvites)
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true)
  })

  test("the list holds the member's own invitations and their unverified registrations", async () => {
    const owner = await member('lister')
    const other = await member('bystander')
    await createInvite(other.deps, other.principal, {})
    const created = await createInvite(owner.deps, owner.principal, {})
    await registerAccount(owner.deps, {
      email: 'pending@example.com',
      username: 'pendingone',
      displayName: 'Pending',
      password: 'tomato-umbrella-47-lantern',
      inviteCode: created.code,
      idempotencyKey: 'k2',
    })
    const listed = await listInvites(owner.deps, owner.principal)
    expect(listed.invites.map((i) => i.id)).toEqual([created.id])
    expect(listed.invites[0]?.useCount).toBe(1)
    expect(listed.registrations).toHaveLength(1)
    expect(listed.registrations[0]).toMatchObject({
      inviteId: created.id,
      status: 'confirmed',
      username: 'pendingone',
    })
    // Another member sees none of it.
    expect((await listInvites(other.deps, other.principal)).registrations).toHaveLength(0)
  })
})
