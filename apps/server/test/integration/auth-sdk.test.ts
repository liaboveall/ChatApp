/**
 * V-04 / V-05 / V-13 experiments against the locked Better Auth version: what the SDK does with our schema,
 * cookies and hooks, and where we must not rely on it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { authorizationOrigins, sessions, users, verifications } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { cookieNames, createAuth } from '../../src/auth/better-auth.ts'
import { resolveSessionPrincipal, revokeAllDevices } from '../../src/domain/sessions.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps, TEST_ORIGIN, TEST_PASSWORD } from '../support/deps.ts'

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

const SECRET = 'k3Jx9QvLm2ZpWn8RtYb4HcDf7GsAe1UoIiTqVyPz'

function setup(origin = TEST_ORIGIN) {
  const deps = makeDeps(dbs.app.db)
  const auth = createAuth(deps, { baseOrigin: origin, secret: SECRET })
  return { deps, auth }
}

async function signIn(
  auth: ReturnType<typeof setup>['auth'],
  body: { email: string; password: string },
  origin = TEST_ORIGIN,
) {
  try {
    const response = await auth.api.signInEmail({
      body,
      headers: new Headers({ origin, 'content-type': 'application/json' }),
      asResponse: true,
    })
    return {
      status: response.status,
      headers: response.headers,
      json: (await response.json()) as Record<string, unknown>,
    }
  } catch (error) {
    const err = error as { statusCode?: number; status?: number | string; body?: { code?: string } }
    return {
      status: Number(err.statusCode ?? err.status),
      headers: new Headers(),
      json: { code: err.body?.code },
    }
  }
}

describe('V-04: uuid primary keys', () => {
  test('SDK-created rows get UUIDv7 ids and the SDK reads our columns', async () => {
    const { deps, auth } = setup()
    const alice = await createActiveUser(deps, { username: 'alice' })
    const result = await signIn(auth, { email: alice.email, password: alice.password })
    expect(result.status).toBe(200)
    const [session] = await dbs.owner.db.select().from(sessions)
    expect(session?.id.split('-')[2]?.[0]).toBe('7')

    // The passkey challenge store goes through the SDK's generateId (our UUIDv7 factory).
    await auth.api.generatePasskeyAuthenticationOptions({
      headers: new Headers({ origin: TEST_ORIGIN }),
    })
    const rows = await dbs.owner.db.select().from(verifications)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id.split('-')[2]?.[0]).toBe('7')
  })

  test('the session token is stored in plaintext and the cookie carries token.signature (V-13 finding)', async () => {
    const { deps, auth } = setup()
    const bob = await createActiveUser(deps, { username: 'bob' })
    const result = await signIn(auth, { email: bob.email, password: bob.password })
    const [session] = await dbs.owner.db.select().from(sessions)
    const cookie = result.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(encodeURIComponent(`${session?.token}.`))
    expect(session?.token).toHaveLength(32)
  })
})

describe('V-05: cookie names and attributes', () => {
  test('http development origin: plain name, HttpOnly, SameSite=Lax, Path=/, no Secure, no Domain', async () => {
    const { deps, auth } = setup('http://localhost:5173')
    const user = await createActiveUser(deps, { username: 'carol' })
    const result = await signIn(auth, { email: user.email, password: user.password })
    const cookie = result.headers.get('set-cookie') ?? ''
    expect(cookie.startsWith(`${cookieNames('http://localhost:5173').sessionToken}=`)).toBe(true)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).not.toMatch(/;\s*Secure/i)
    expect(cookie).not.toMatch(/Domain=/i)
  })

  test('https origin: __Host- prefix with Secure, Path=/ and no Domain (V-05 passes)', async () => {
    const origin = 'https://chat.example.com'
    const { deps, auth } = setup(origin)
    const user = await createActiveUser(deps, { username: 'dora' })
    const result = await signIn(auth, { email: user.email, password: user.password }, origin)
    expect(result.status).toBe(200)
    const cookie = result.headers.get('set-cookie') ?? ''
    expect(cookie.startsWith('__Host-chatapp.session_token=')).toBe(true)
    expect(cookie).toMatch(/;\s*Secure/i)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).not.toMatch(/Domain=/i)
    expect(cookie).not.toContain('__Secure-')
  })
})

describe('login hook: gating, origin and epoch', () => {
  test('a session gets its device origin and the account auth epoch', async () => {
    const { deps, auth } = setup()
    const user = await createActiveUser(deps, { username: 'erin' })
    await dbs.owner.db.update(users).set({ authEpoch: 3 }).where(eq(users.id, user.id))
    const result = await signIn(auth, { email: user.email, password: user.password })
    expect(result.status).toBe(200)
    const [session] = await dbs.owner.db.select().from(sessions)
    const [origin] = await dbs.owner.db.select().from(authorizationOrigins)
    expect(session).toMatchObject({ authEpoch: 3, authorizationOriginId: origin?.id })
    expect(origin).toMatchObject({
      userId: user.id,
      restoreEpoch: deps.config.auth.restoreEpoch,
      revokedAt: null,
    })
  })

  test('wrong password and unknown email are indistinguishable', async () => {
    const { deps, auth } = setup()
    const user = await createActiveUser(deps, { username: 'frank' })
    const wrong = await signIn(auth, { email: user.email, password: 'nope-nope-nope' })
    const unknown = await signIn(auth, { email: 'nobody@example.com', password: 'nope-nope-nope' })
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.json).toEqual(unknown.json)
    expect(await dbs.owner.db.select().from(sessions)).toHaveLength(0)
  })

  test('banned, unverified, pending and deleted accounts never get a session', async () => {
    const { deps, auth } = setup()
    const banned = await createActiveUser(deps, { username: 'gina' })
    await dbs.owner.db.update(users).set({ banned: true }).where(eq(users.id, banned.id))
    const unverified = await createActiveUser(deps, { username: 'hank' })
    await dbs.owner.db
      .update(users)
      .set({ emailVerified: false, activationStatus: 'pending' })
      .where(eq(users.id, unverified.id))
    const revoked = await createActiveUser(deps, { username: 'ivan' })
    await dbs.owner.db
      .update(users)
      .set({ activationStatus: 'revoked' })
      .where(eq(users.id, revoked.id))
    const deleted = await createActiveUser(deps, { username: 'judy' })
    await dbs.owner.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, deleted.id))

    for (const account of [banned, unverified, revoked, deleted]) {
      const result = await signIn(auth, { email: account.email, password: account.password })
      expect(result.status).toBe(403)
    }
    expect(await dbs.owner.db.select().from(sessions)).toHaveLength(0)
    // Refused logins must not leave orphan origins behind except for the account-state failures that never reach the hook.
    expect(await dbs.owner.db.select().from(authorizationOrigins)).toHaveLength(0)
  })

  test('an expired ban lets the account in again', async () => {
    const { deps, auth } = setup()
    const user = await createActiveUser(deps, { username: 'kate' })
    await dbs.owner.db
      .update(users)
      .set({ banned: true, banExpires: new Date(Date.now() - 1000) })
      .where(eq(users.id, user.id))
    expect((await signIn(auth, { email: user.email, password: user.password })).status).toBe(200)
  })
})

describe('sessions seen through getSession and our principal check', () => {
  async function loggedIn() {
    const { deps, auth } = setup()
    const user = await createActiveUser(deps, { username: 'leo' })
    const result = await signIn(auth, { email: user.email, password: user.password })
    const cookie = (result.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    return { deps, auth, user, cookie }
  }

  test('getSession returns the additional fields and the principal resolves', async () => {
    const { deps, auth, user, cookie } = await loggedIn()
    const found = await auth.api.getSession({ headers: new Headers({ cookie }) })
    expect(found?.session).toMatchObject({ userId: user.id })
    const record = found?.session as unknown as {
      id: string
      authEpoch: number
      authorizationOriginId: string
      expiresAt: Date
    }
    expect(typeof record.authorizationOriginId).toBe('string')
    const principal = await resolveSessionPrincipal(deps, {
      id: record.id,
      userId: user.id,
      expiresAt: record.expiresAt,
      authEpoch: record.authEpoch,
      authorizationOriginId: record.authorizationOriginId,
    })
    expect(principal).toMatchObject({ kind: 'session', userId: user.id, role: 'user' })
  })

  test('a tampered cookie signature is rejected by the SDK', async () => {
    const { auth, cookie } = await loggedIn()
    const tampered = `${cookie.slice(0, -3)}AAA`
    expect(await auth.api.getSession({ headers: new Headers({ cookie: tampered }) })).toBeNull()
  })

  test('security revocation kills the session at the database and in the principal check', async () => {
    const { deps, auth, cookie } = await loggedIn()
    const found = await auth.api.getSession({ headers: new Headers({ cookie }) })
    const record = found?.session as unknown as {
      id: string
      userId: string
      authEpoch: number
      authorizationOriginId: string
      expiresAt: Date
    }
    const principal = await resolveSessionPrincipal(deps, { ...record })
    expect(principal).not.toBeNull()
    if (!principal) return
    await revokeAllDevices(deps, principal)
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull()
    expect(await resolveSessionPrincipal(deps, { ...record })).toBeNull()
  })
})

describe('second line of defence inside the SDK', () => {
  test('SDK sign-up is disabled and direct user/account creation through its adapter is refused', async () => {
    const { auth } = setup()
    const attempt = async () =>
      auth.api.signUpEmail({
        body: { email: 'new@example.com', password: TEST_PASSWORD, name: 'New' },
        headers: new Headers({ origin: TEST_ORIGIN }),
      })
    await expect(attempt()).rejects.toThrow()
    expect(await dbs.owner.db.select().from(users)).toHaveLength(0)

    const context = await auth.$context
    await expect(
      context.internalAdapter.createUser(
        { email: 'x@example.com', name: 'X' },
        { method: 'email-password' },
      ),
    ).rejects.toThrow()
    expect(await dbs.owner.db.select().from(users)).toHaveLength(0)
  })
})
