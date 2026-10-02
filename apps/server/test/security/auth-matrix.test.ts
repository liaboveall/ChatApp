/**
 * V-13 / AT-04 / AT-25: every endpoint the locked Better Auth version registers is attacked through the real HTTP
 * application as anonymous, member and administrator. Anything not on our allowlist must be a plain 404 with no
 * side effect; the allowlisted SDK routes must stay reachable only under their own access rules.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AUTH_ENDPOINTS } from '@chatapp/contracts'
import { accounts, authChallenges, passkeys, sessions, users, verifications } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, readLiveToken } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'

let dbs: TestDatabases
let app: TestApp

beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  app = await createTestApp(dbs)
})
afterEach(async () => {
  await app.close()
})

type SdkEndpoint = { method: string; path: string }

/** Every method + path the SDK (with the passkey plugin) registers, read from the live instance. */
function sdkEndpoints(): SdkEndpoint[] {
  const out: SdkEndpoint[] = []
  for (const endpoint of Object.values(app.services.auth.api) as Array<{
    path?: string
    options?: { method?: string | string[] }
  }>) {
    if (!endpoint.path) continue
    const methods = endpoint.options?.method
    for (const method of Array.isArray(methods) ? methods : [methods ?? 'GET']) {
      out.push({ method, path: `/api/auth${endpoint.path.replaceAll(/:[A-Za-z]+/g, 'x')}` })
    }
  }
  return out
}

const allowed = (method: string, path: string) =>
  AUTH_ENDPOINTS.some((endpoint) => endpoint.method === method && endpoint.path === path)

async function snapshotRows() {
  return {
    users: (await dbs.owner.db.select().from(users)).map((u) => [
      u.id,
      u.email,
      u.role,
      u.emailVerified,
      u.activationStatus,
      u.authEpoch,
      u.deletedAt,
      u.banned,
    ]),
    accounts: (await dbs.owner.db.select().from(accounts)).map((a) => [a.id, a.password]),
    sessions: (await dbs.owner.db.select().from(sessions)).map((s) => s.id),
    passkeys: (await dbs.owner.db.select().from(passkeys)).length,
    challenges: (await dbs.owner.db.select().from(authChallenges)).map((c) => [
      c.id,
      c.consumedAt,
      c.revokedAt,
    ]),
  }
}

async function signedIn(username: string, role: 'user' | 'admin') {
  const user = await createActiveUser(app.services.deps, { username, role })
  const jar = app.newJar()
  const response = await app.request('/api/auth/sign-in/email', {
    json: { email: user.email, password: user.password },
    jar,
  })
  expect(response.status).toBe(200)
  return { user, jar }
}

describe('every SDK endpoint, as anonymous, member and administrator', () => {
  test('is a 404 unless it is on the allowlist, and changes nothing', async () => {
    const member = await signedIn('member', 'user')
    const admin = await signedIn('boss', 'admin')
    const before = await snapshotRows()
    const endpoints = sdkEndpoints()
    expect(endpoints.length).toBeGreaterThan(30) // the SDK really was enumerated

    const unexpected: string[] = []
    for (const { method, path } of endpoints) {
      for (const [who, jar] of [
        ['anonymous', undefined],
        ['member', member.jar],
        ['admin', admin.jar],
      ] as const) {
        const response = await app.request(path, {
          method,
          jar,
          ...(method === 'POST' ? { json: {} } : {}),
        })
        if (allowed(method, path)) {
          // Reachable, but only under its own rules: never a 404 and never a server error.
          if (response.status === 404 || response.status >= 500)
            unexpected.push(`${who} ${method} ${path} -> ${response.status}`)
        } else if (response.status !== 404) {
          unexpected.push(`${who} ${method} ${path} -> ${response.status}`)
        }
      }
    }
    expect(unexpected).toEqual([])
    const after = await snapshotRows()
    expect(after.users).toEqual(before.users)
    expect(after.accounts).toEqual(before.accounts)
    expect(after.passkeys).toBe(before.passkeys)
    expect(after.challenges).toEqual(before.challenges)
  })

  test('names that belong to plugins we do not run are 404 too', async () => {
    const admin = await signedIn('boss2', 'admin')
    const paths = [
      '/api/auth/admin/impersonate-user',
      '/api/auth/admin/set-user-password',
      '/api/auth/admin/create-user',
      '/api/auth/admin/ban-user',
      '/api/auth/admin/remove-user',
      '/api/auth/sign-in/username',
      '/api/auth/is-username-available',
      '/api/auth/two-factor/enable',
      '/api/auth/jwks',
      '/api/auth/token',
      '/api/auth/oauth2/authorize',
      '/api/auth/magic-link/verify',
      '/api/auth/email-otp/send-verification-otp',
      '/api/auth/phone-number/send-otp',
      '/api/auth/organization/create',
      '/api/auth/api-key/create',
      '/api/auth/multi-session/list-device-sessions',
      '/api/auth/sign-in/anonymous',
    ]
    for (const path of paths) {
      for (const method of ['GET', 'POST']) {
        const response = await app.request(path, {
          method,
          jar: admin.jar,
          ...(method === 'POST' ? { json: {} } : {}),
        })
        expect(response.status, `${method} ${path}`).toBe(404)
      }
    }
  })

  test('route variants of allowlisted paths are refused: case, trailing slash, encoding, extra segments, wrong method', async () => {
    const variants: Array<[string, string]> = [
      ['POST', '/api/auth/Sign-In/email'],
      ['POST', '/api/auth/sign-in/email/'],
      ['POST', '/api/auth//sign-in/email'],
      ['POST', '/api/auth/sign-in/email/extra'],
      ['POST', '/api/auth/sign-in/%65mail'],
      ['POST', '/api/auth/sign-in/email%2f'],
      ['POST', '/api/auth/sign-in/email;x=1'],
      ['GET', '/api/auth/sign-in/email'],
      ['PUT', '/api/auth/sign-in/email'],
      ['PATCH', '/api/auth/sign-up/email'],
      ['GET', '/api/auth/sign-up/email'],
      ['GET', '/api/auth/verification/consume'],
      ['GET', '/api/auth/password/consume-reset'],
      ['POST', '/api/auth/passkey/generate-authenticate-options'],
      ['GET', '/api/auth/passkey/verify-authentication'],
    ]
    for (const [method, path] of variants) {
      const response = await app.request(path, {
        method,
        ...(method !== 'GET' ? { json: {} } : {}),
      })
      // A listed path with the wrong verb is a 404 as well (method + path are matched together).
      expect([404], `${method} ${path}`).toContain(response.status)
    }
  })
})

describe('credentials cannot be consumed or leaked through GET or the SDK (AT-25)', () => {
  test('a valid verification token does nothing when sent to SDK-style or GET routes', async () => {
    // A genuine registration, so the credential is bound to a confirmed registration like in production.
    const admin = await createActiveUser(app.services.deps, { username: 'boss3', role: 'admin' })
    const jar = app.newJar()
    await app.request('/api/auth/sign-in/email', {
      json: { email: admin.email, password: admin.password },
      jar,
    })
    const invite = (await (await app.request('/api/invites', { json: {}, jar })).json()) as {
      code: string
    }
    await app.request('/api/auth/sign-up/email', {
      json: {
        email: 'pending@example.com',
        username: 'pending',
        name: 'Pending',
        password: 'tomato-umbrella-47-lantern',
      },
      headers: { 'x-invite-code': invite.code, 'idempotency-key': 'k1' },
    })
    const [pending] = await dbs.owner.db.select().from(users).where(eq(users.username, 'pending'))
    const token = await readLiveToken(app.services.deps, pending?.id ?? '', 'verify_email')
    expect(token).toHaveLength(43)

    for (const path of [
      `/api/auth/verify-email?token=${token}`,
      `/api/auth/verification/consume?token=${token}`,
      `/api/auth/reset-password/${token}`,
      `/api/auth/reset-password?token=${token}`,
    ]) {
      expect((await app.request(path)).status, path).toBe(404)
    }
    const [row] = await dbs.owner.db
      .select()
      .from(users)
      .where(eq(users.id, pending?.id ?? ''))
    expect(row).toMatchObject({ emailVerified: false, activationStatus: 'pending' })
    // The credential is still live and still usable through the one real endpoint.
    expect(await readLiveToken(app.services.deps, pending?.id ?? '', 'verify_email')).toBe(token)
    expect((await app.request('/api/auth/verification/consume', { json: { token } })).status).toBe(
      200,
    )
  })
})

describe('accounts that must never get a session (INV-18, SEC-31)', () => {
  test('bots have no credential, pending and deleted accounts are refused, nobody signs in by username', async () => {
    const deps = app.services.deps
    const [bot] = await dbs.owner.db
      .insert(users)
      .values({
        name: 'Bot',
        email: 'bot@bot.invalid',
        username: 'robot',
        accountSource: 'bootstrap',
        isBot: true,
        emailVerified: true,
        activationStatus: 'active',
      })
      .returning({ id: users.id })
    expect(bot).toBeDefined()
    const botLogin = await app.request('/api/auth/sign-in/email', {
      json: { email: 'bot@bot.invalid', password: 'anything-at-all-123' },
    })
    expect(botLogin.status).toBe(401)

    const pending = await createActiveUser(deps, { username: 'pend' })
    await dbs.owner.db
      .update(users)
      .set({ activationStatus: 'pending', emailVerified: false })
      .where(eq(users.id, pending.id))
    const deleted = await createActiveUser(deps, { username: 'gone' })
    await dbs.owner.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, deleted.id))
    for (const account of [pending, deleted]) {
      const response = await app.request('/api/auth/sign-in/email', {
        json: { email: account.email, password: account.password },
      })
      expect(response.status).toBe(403)
    }
    const byUsername = await app.request('/api/auth/sign-in/email', {
      json: { username: 'pend', password: pending.password },
    })
    expect(byUsername.status).toBe(422)
    expect(await dbs.owner.db.select().from(sessions)).toHaveLength(0)
  })
})

describe('privileged and verified fields cannot be smuggled in', () => {
  test('registration and login bodies are strict', async () => {
    const admin = await createActiveUser(app.services.deps, { username: 'inviter', role: 'admin' })
    const jar = app.newJar()
    await app.request('/api/auth/sign-in/email', {
      json: { email: admin.email, password: admin.password },
      jar,
    })
    const invite = (await (await app.request('/api/invites', { json: {}, jar })).json()) as {
      code: string
    }
    const base = {
      email: 'new@example.com',
      username: 'newuser',
      name: 'New',
      password: 'tomato-umbrella-47-lantern',
    }
    const before = (await dbs.owner.db.select().from(users)).length
    for (const extra of [
      { role: 'admin' },
      { isBot: true },
      { emailVerified: true },
      { activationStatus: 'active' },
      { registrationId: crypto.randomUUID() },
      { banned: false },
      { id: crypto.randomUUID() },
      { inviteQuota: 999 },
      { callbackURL: 'https://evil.example' },
    ]) {
      const response = await app.request('/api/auth/sign-up/email', {
        json: { ...base, ...extra },
        headers: { 'x-invite-code': invite.code, 'idempotency-key': `k-${Object.keys(extra)[0]}` },
      })
      expect(response.status, JSON.stringify(extra)).toBe(422)
    }
    expect((await dbs.owner.db.select().from(users)).length).toBe(before)
    const login = await app.request('/api/auth/sign-in/email', {
      json: { email: admin.email, password: admin.password, callbackURL: 'https://evil.example' },
    })
    expect(login.status).toBe(422)
  })
})

describe('allowlisted passkey routes keep their access rules and strict inputs', () => {
  test('anonymous login ceremony starts; management routes need a session', async () => {
    const start = await app.request('/api/auth/passkey/generate-authenticate-options')
    expect(start.status).toBe(200)
    const options = (await start.json()) as { challenge?: string }
    expect(typeof options.challenge).toBe('string')
    expect(await dbs.owner.db.select().from(verifications)).toHaveLength(1)

    for (const [method, path] of [
      ['GET', '/api/auth/passkey/generate-register-options'],
      ['GET', '/api/auth/passkey/list-user-passkeys'],
      ['POST', '/api/auth/passkey/verify-registration'],
      ['POST', '/api/auth/passkey/update-passkey'],
      ['POST', '/api/auth/passkey/delete-passkey'],
    ] as const) {
      const response = await app.request(path, {
        method,
        ...(method === 'POST' ? { json: {} } : {}),
      })
      expect(response.status, path).toBe(401)
    }
  })

  test('a signed-in member gets registration options, but unknown fields and parameters are refused', async () => {
    const member = await createActiveUser(app.services.deps, { username: 'keyholder' })
    const jar = app.newJar()
    await app.request('/api/auth/sign-in/email', {
      json: { email: member.email, password: member.password },
      jar,
    })
    expect((await app.request('/api/auth/passkey/generate-register-options', { jar })).status).toBe(
      200,
    )
    expect(
      (
        await app.request('/api/auth/passkey/generate-register-options?userId=someone-else', {
          jar,
        })
      ).status,
    ).toBe(422)
    expect(
      (await app.request('/api/auth/passkey/list-user-passkeys?userId=x', { jar })).status,
    ).toBe(422)
    // `createSession` would let the SDK mint a second session during registration: it is not accepted.
    const smuggled = await app.request('/api/auth/passkey/verify-registration', {
      json: { response: {}, createSession: true },
      jar,
    })
    expect(smuggled.status).toBe(422)
    const unknownField = await app.request('/api/auth/passkey/delete-passkey', {
      json: { id: crypto.randomUUID(), userId: crypto.randomUUID() },
      jar,
    })
    expect(unknownField.status).toBe(422)
  })
})
