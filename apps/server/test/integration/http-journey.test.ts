/**
 * The M1a acceptance walk-through at the interface level (docs/11 M1a "验收"), minus the WebSocket step which
 * has its own tests: administrator -> invitation -> registration -> email verification -> login -> session use ->
 * sign-out. Every step goes through the real HTTP application, Postgres and Valkey.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { authChallenges, sessions, users, workItems } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, readLiveToken } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'

let dbs: TestDatabases
let app: TestApp

beforeAll(async () => {
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

const PASSWORD = 'tomato-umbrella-47-lantern'

async function login(email: string, password: string, jar = app.newJar()) {
  const response = await app.request('/api/auth/sign-in/email', { json: { email, password }, jar })
  return { response, jar }
}

describe('the interface-level acceptance journey', () => {
  test('admin creates an invitation, a new person registers, verifies by email, signs in and out', async () => {
    const admin = await createActiveUser(app.services.deps, { username: 'boss', role: 'admin' })

    // 1+2. The administrator signs in and creates an invitation code.
    const adminLogin = await login(admin.email, admin.password)
    expect(adminLogin.response.status).toBe(200)
    expect(await adminLogin.response.json()).toEqual({ status: 'ok' })
    const created = await app.request('/api/invites', {
      json: { note: 'for Wang' },
      jar: adminLogin.jar,
    })
    expect(created.status).toBe(201)
    const invite = (await created.json()) as { id: string; code: string }
    expect(invite.code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/)

    // The public check accepts the code (no session needed) and rejects a made-up one.
    expect((await app.request('/api/invites/check', { json: { code: invite.code } })).status).toBe(
      200,
    )
    const unknown = await app.request('/api/invites/check', {
      json: { code: 'AAAA-AAAA-AAAA-AAAA' },
    })
    expect(unknown.status).toBe(400)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
      'INVITE_INVALID',
    )

    // 3. Registration without a code fails; with the code it is accepted and sends a mail job.
    const form = { email: 'wang@example.com', username: 'wang', name: '王小明', password: PASSWORD }
    const noCode = await app.request('/api/auth/sign-up/email', {
      json: form,
      headers: { 'idempotency-key': 'reg-1' },
    })
    expect(noCode.status).toBe(400)
    const accepted = await app.request('/api/auth/sign-up/email', {
      json: form,
      headers: { 'x-invite-code': invite.code, 'idempotency-key': 'reg-1' },
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ status: 'verification_required' })
    expect(
      (await dbs.owner.db.select().from(workItems).where(eq(workItems.kind, 'email'))).length,
    ).toBe(1)

    // The new account cannot sign in before it has verified its email, and the error says exactly that.
    const early = await login(form.email, PASSWORD)
    expect(early.response.status).toBe(403)
    expect(await early.response.json()).toEqual({
      code: 'EMAIL_NOT_VERIFIED',
      message: 'Email is not verified',
    })

    // 4. Verification: the link's token is consumed through the controlled endpoint (a GET only shows a static page).
    const [wang] = await dbs.owner.db.select().from(users).where(eq(users.username, 'wang'))
    const token = await readLiveToken(app.services.deps, wang?.id ?? '', 'verify_email')
    expect((await app.request(`/api/auth/verification/consume`, { method: 'GET' })).status).toBe(
      404,
    )
    const consumed = await app.request('/api/auth/verification/consume', { json: { token } })
    expect(consumed.status).toBe(200)
    // The same credential is dead afterwards, with the generic error.
    const again = await app.request('/api/auth/verification/consume', { json: { token } })
    expect(again.status).toBe(400)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      'AUTH_CHALLENGE_INVALID',
    )

    // 5. Login works now, the cookie is HttpOnly and the body carries no token.
    const wangLogin = await login(form.email, PASSWORD)
    expect(wangLogin.response.status).toBe(200)
    const cookie = wangLogin.response.headers.getSetCookie().join('\n')
    expect(cookie).toContain('chatapp.session_token=')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(JSON.stringify(await wangLogin.response.clone().json())).not.toMatch(/token/i)

    // The session is usable: /api/me, the device list and the inviter bookkeeping.
    const me = (await (await app.request('/api/me', { jar: wangLogin.jar })).json()) as Record<
      string,
      unknown
    >
    expect(me).toMatchObject({
      username: 'wang',
      displayName: '王小明',
      email: 'wang@example.com',
      role: 'user',
      isBot: false,
      authEpoch: 0,
    })
    const devices = (await (
      await app.request('/api/me/devices', { jar: wangLogin.jar })
    ).json()) as { devices: Array<{ current: boolean }> }
    expect(devices.devices).toHaveLength(1)
    expect(devices.devices[0]?.current).toBe(true)
    const adminInvites = (await (
      await app.request('/api/invites', { jar: adminLogin.jar })
    ).json()) as { invites: Array<{ useCount: number }>; registrations: unknown[] }
    expect(adminInvites.invites[0]?.useCount).toBe(1)
    expect(adminInvites.registrations).toHaveLength(0) // verified now

    // 6. Sign-out ends the session; the cookie is cleared and /api/me is 401 from then on.
    const out = await app.request('/api/auth/sign-out', { method: 'POST', jar: wangLogin.jar })
    expect(out.status).toBe(200)
    expect(wangLogin.jar.size).toBe(0)
    const after = await app.request('/api/me', { jar: wangLogin.jar })
    expect(after.status).toBe(401)
    expect(
      await dbs.owner.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, wang?.id ?? '')),
    ).toHaveLength(0)
  })

  test('an unverified registration is visible to its inviter, who can withdraw it', async () => {
    const admin = await createActiveUser(app.services.deps, { username: 'boss2', role: 'admin' })
    const { jar } = await login(admin.email, admin.password)
    const invite = (await (await app.request('/api/invites', { json: {}, jar })).json()) as {
      code: string
    }
    await app.request('/api/auth/sign-up/email', {
      json: { email: 'late@example.com', username: 'late', name: 'Late', password: PASSWORD },
      headers: { 'x-invite-code': invite.code, 'idempotency-key': 'reg-2' },
    })
    const listed = (await (await app.request('/api/invites', { jar })).json()) as {
      registrations: Array<{ id: string; username: string; status: string }>
    }
    expect(listed.registrations).toHaveLength(1)
    expect(listed.registrations[0]).toMatchObject({ username: 'late', status: 'confirmed' })

    const withdrawn = await app.request(
      `/api/invites/registrations/${listed.registrations[0]?.id}`,
      { method: 'DELETE', jar },
    )
    expect(withdrawn.status).toBe(200)
    expect(await dbs.owner.db.select().from(users).where(eq(users.username, 'late'))).toHaveLength(
      0,
    )
    expect((await dbs.owner.db.select().from(authChallenges)).length).toBe(0)
    const relisted = (await (await app.request('/api/invites', { jar })).json()) as {
      invites: Array<{ useCount: number }>
      registrations: unknown[]
    }
    expect(relisted.invites[0]?.useCount).toBe(0)
    expect(relisted.registrations).toHaveLength(0)
  })
})
