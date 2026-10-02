/** Identity flows over HTTP: devices, revocation, password change and reset, expiry and bans (docs/03 section 5.8-5.9). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { authorizationOrigins, sessions, users, workItems } from '@chatapp/db'
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

type Account = Awaited<ReturnType<typeof createActiveUser>>

async function signIn(account: Account, options: { rememberMe?: boolean; password?: string } = {}) {
  const jar = app.newJar()
  const response = await app.request('/api/auth/sign-in/email', {
    json: {
      email: account.email,
      password: options.password ?? account.password,
      rememberMe: options.rememberMe,
    },
    jar,
  })
  return { jar, response }
}
const me = (jar: ReturnType<TestApp['newJar']>) => app.request('/api/me', { jar })
const errorOf = async (response: Response) =>
  (await response.clone().json()) as {
    error?: { code?: string; details?: Record<string, unknown> }
  }

describe('devices and revocation', () => {
  test('revoke-others keeps this browser and ends the rest, whose cookies are told to go away', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'dev1' })
    const a = await signIn(user)
    const b = await signIn(user)
    const list = (await (await app.request('/api/me/devices', { jar: a.jar })).json()) as {
      devices: Array<{ id: string; current: boolean }>
    }
    expect(list.devices).toHaveLength(2)
    expect(list.devices.filter((d) => d.current)).toHaveLength(1)

    expect(
      (await app.request('/api/me/devices/revoke-others', { method: 'POST', jar: a.jar })).status,
    ).toBe(200)
    expect((await me(a.jar)).status).toBe(200)
    const dead = await me(b.jar)
    expect(dead.status).toBe(401)
    expect(b.jar.size).toBe(0) // the stale cookie was deleted by the response
    expect((await errorOf(dead)).error?.code).toBe('UNAUTHENTICATED')
  })

  test('revoking one device by id ends that device; revoking this device ends this session too', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'dev2' })
    const a = await signIn(user)
    const b = await signIn(user)
    const devices = (await (await app.request('/api/me/devices', { jar: a.jar })).json()) as {
      devices: Array<{ id: string; current: boolean }>
    }
    const other = devices.devices.find((d) => !d.current)
    const current = devices.devices.find((d) => d.current)
    expect(
      (await app.request(`/api/me/devices/${other?.id}`, { method: 'DELETE', jar: a.jar })).status,
    ).toBe(200)
    expect((await me(b.jar)).status).toBe(401)
    expect((await me(a.jar)).status).toBe(200)

    expect(
      (await app.request(`/api/me/devices/${current?.id}`, { method: 'DELETE', jar: a.jar }))
        .status,
    ).toBe(200)
    expect(a.jar.size).toBe(0)
    expect((await me(a.jar)).status).toBe(401)
    // An id that is not yours, or not an id at all, is a 404 / validation error and revokes nothing.
    const c = await signIn(user)
    expect(
      (
        await app.request(`/api/me/devices/${crypto.randomUUID()}`, {
          method: 'DELETE',
          jar: c.jar,
        })
      ).status,
    ).toBe(404)
    expect(
      (await app.request('/api/me/devices/not-a-uuid', { method: 'DELETE', jar: c.jar })).status,
    ).toBe(422)
    expect((await me(c.jar)).status).toBe(200)
  })

  test('security sign-out everywhere ends every session including this one and moves the epoch', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'dev3' })
    const a = await signIn(user)
    const b = await signIn(user)
    expect(
      (await app.request('/api/me/devices/revoke-all', { method: 'POST', jar: a.jar })).status,
    ).toBe(200)
    expect(a.jar.size).toBe(0)
    expect((await me(b.jar)).status).toBe(401)
    expect(
      (await dbs.owner.db.select().from(users).where(eq(users.id, user.id)))[0]?.authEpoch,
    ).toBe(1)
    // Signing in again works and starts under the new epoch.
    const again = await signIn(user)
    expect(again.response.status).toBe(200)
    expect(((await (await me(again.jar)).json()) as { authEpoch: number }).authEpoch).toBe(1)
  })

  test('a plain sign-out leaves other devices alone', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'dev4' })
    const a = await signIn(user)
    const b = await signIn(user)
    expect((await app.request('/api/auth/sign-out', { method: 'POST', jar: a.jar })).status).toBe(
      200,
    )
    expect((await me(a.jar)).status).toBe(401)
    expect((await me(b.jar)).status).toBe(200)
    // Signing out without any session still answers 200 (idempotent).
    expect((await app.request('/api/auth/sign-out', { method: 'POST' })).status).toBe(200)
  })

  test('revocation needs a live session and the site origin', async () => {
    expect((await app.request('/api/me/devices/revoke-all', { method: 'POST' })).status).toBe(401)
    const user = await createActiveUser(app.services.deps, { username: 'dev5' })
    const a = await signIn(user)
    expect(
      (
        await app.request('/api/me/devices/revoke-all', {
          method: 'POST',
          jar: a.jar,
          origin: 'http://evil.example',
        })
      ).status,
    ).toBe(403)
    expect((await me(a.jar)).status).toBe(200)
  })
})

describe('password change over HTTP', () => {
  test('ends other sessions, keeps this one, and the new password is the only one that works', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'pw1' })
    const a = await signIn(user)
    const b = await signIn(user)
    const changed = await app.request('/api/auth/change-password', {
      json: { currentPassword: user.password, newPassword: 'violet-harbor-91-compass' },
      jar: a.jar,
    })
    expect(changed.status).toBe(200)
    expect((await me(b.jar)).status).toBe(401)
    const still = await me(a.jar)
    expect(still.status).toBe(200)
    expect(((await still.json()) as { authEpoch: number }).authEpoch).toBe(1)

    expect((await signIn(user)).response.status).toBe(401) // old password
    expect((await signIn(user, { password: 'violet-harbor-91-compass' })).response.status).toBe(200)
  })

  test('a wrong current password or a weak new one changes nothing', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'pw2' })
    const a = await signIn(user)
    const wrong = await app.request('/api/auth/change-password', {
      json: { currentPassword: 'not-my-password', newPassword: 'violet-harbor-91-compass' },
      jar: a.jar,
    })
    expect(wrong.status).toBe(403)
    const weak = await app.request('/api/auth/change-password', {
      json: { currentPassword: user.password, newPassword: 'qwertyuiop' },
      jar: a.jar,
    })
    expect(weak.status).toBe(422)
    expect((await errorOf(weak)).error?.details).toMatchObject({
      field: 'password',
      reason: 'too_common',
    })
    expect((await signIn(user)).response.status).toBe(200)
    expect(
      await app
        .request('/api/auth/change-password', {
          json: { currentPassword: user.password, newPassword: 'violet-harbor-91-compass' },
        })
        .then((r) => r.status),
    ).toBe(401)
  })
})

describe('password reset over HTTP', () => {
  test('request, then consume: new password works, every session is gone, the link is single use', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'rs1' })
    const a = await signIn(user)
    const b = await signIn(user)
    expect(
      (await app.request('/api/auth/password/request-reset', { json: { email: user.email } }))
        .status,
    ).toBe(202)
    expect(
      (await dbs.owner.db.select().from(workItems).where(eq(workItems.kind, 'email'))).length,
    ).toBe(1)
    const token = await readLiveToken(app.services.deps, user.id, 'reset_password')

    const weak = await app.request('/api/auth/password/consume-reset', {
      json: { token, newPassword: 'password123' },
    })
    expect(weak.status).toBe(422)
    const done = await app.request('/api/auth/password/consume-reset', {
      json: { token, newPassword: 'violet-harbor-91-compass' },
    })
    expect(done.status).toBe(200)
    expect((await me(a.jar)).status).toBe(401)
    expect((await me(b.jar)).status).toBe(401)
    expect(
      await dbs.owner.db.select().from(sessions).where(eq(sessions.userId, user.id)),
    ).toHaveLength(0)
    // Nothing signed anybody in.
    expect(done.headers.getSetCookie()).toHaveLength(0)

    const reuse = await app.request('/api/auth/password/consume-reset', {
      json: { token, newPassword: 'another-fine-pass-77' },
    })
    expect(reuse.status).toBe(400)
    expect((await errorOf(reuse)).error?.code).toBe('AUTH_CHALLENGE_INVALID')
    expect((await signIn(user, { password: 'violet-harbor-91-compass' })).response.status).toBe(200)
  })
})

describe('sessions end when the account or time says so', () => {
  test('a banned account loses access on its next request', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'ban1' })
    const a = await signIn(user)
    expect((await me(a.jar)).status).toBe(200)
    await dbs.owner.db.update(users).set({ banned: true }).where(eq(users.id, user.id))
    expect((await me(a.jar)).status).toBe(401)
  })

  test('a session older than its lifetime is refused even though the cookie is intact', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'old1' })
    const a = await signIn(user)
    expect((await me(a.jar)).status).toBe(200)
    app.clock.advance(31 * 86_400_000)
    expect((await me(a.jar)).status).toBe(401)
  })

  test('a session whose device origin was revoked behind its back is refused', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'org1' })
    const a = await signIn(user)
    await dbs.owner.db
      .update(authorizationOrigins)
      .set({ revokedAt: new Date(), revokeReason: 'device_revoked' })
      .where(eq(authorizationOrigins.userId, user.id))
    expect((await me(a.jar)).status).toBe(401)
  })

  test('"remember me" off yields a browser-session cookie and a shorter lifetime', async () => {
    const user = await createActiveUser(app.services.deps, { username: 'rem1' })
    const kept = await signIn(user, { rememberMe: true })
    const dropped = await signIn(user, { rememberMe: false })
    const cookieOf = (response: Response) =>
      response.headers.getSetCookie().find((c) => c.startsWith('chatapp.session_token=')) ?? ''
    expect(cookieOf(kept.response)).toContain('Max-Age=')
    expect(cookieOf(dropped.response)).not.toContain('Max-Age=')
    expect(
      dropped.response.headers.getSetCookie().some((c) => c.startsWith('chatapp.dont_remember=')),
    ).toBe(true)
  })
})
