/** `PATCH /api/me`: the time zone and its "follow the browser" flag, with optimistic concurrency (docs/05 section 3.1, AT-37). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { users } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser } from '../support/deps.ts'
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

async function signedIn() {
  const user = await createActiveUser(app.services.deps, { username: 'zone' })
  const jar = app.newJar()
  const login = await app.request('/api/auth/sign-in/email', {
    json: { email: user.email, password: user.password },
    jar,
  })
  expect(login.status).toBe(200)
  return { user, jar }
}
const getMe = async (jar: ReturnType<TestApp['newJar']>) =>
  (await (await app.request('/api/me', { jar })).json()) as {
    meVersion: number
    timezone: string
    settings: Record<string, unknown>
  }
const patch = (jar: ReturnType<TestApp['newJar']>, body: unknown) =>
  app.request('/api/me', { method: 'PATCH', json: body, jar })

describe('PATCH /api/me', () => {
  test('changes the time zone and the follow-browser flag, and bumps meVersion', async () => {
    const { jar } = await signedIn()
    const before = await getMe(jar)
    const response = await patch(jar, {
      expectedMeVersion: before.meVersion,
      timezone: 'America/New_York',
      settings: { timezoneAuto: false },
    })
    expect(response.status).toBe(200)
    const after = (await response.json()) as typeof before
    expect(after.timezone).toBe('America/New_York')
    expect(after.settings.timezoneAuto).toBe(false)
    expect(after.meVersion).toBe(before.meVersion + 1)
    expect(await getMe(jar)).toEqual(after)
  })

  test('merges settings key by key instead of replacing them', async () => {
    const { user, jar } = await signedIn()
    await dbs.owner.db
      .update(users)
      .set({ settings: { keepMe: 'yes' } })
      .where(eq(users.id, user.id))
    const before = await getMe(jar)
    const response = await patch(jar, {
      expectedMeVersion: before.meVersion,
      settings: { timezoneAuto: true },
    })
    const after = (await response.json()) as typeof before
    expect(after.settings).toEqual({ keepMe: 'yes', timezoneAuto: true })
    expect(after.timezone).toBe(before.timezone)
  })

  test('a stale meVersion is a 409 and changes nothing', async () => {
    const { jar } = await signedIn()
    const before = await getMe(jar)
    expect(
      (await patch(jar, { expectedMeVersion: before.meVersion, timezone: 'Asia/Tokyo' })).status,
    ).toBe(200)
    const stale = await patch(jar, {
      expectedMeVersion: before.meVersion,
      timezone: 'Europe/Paris',
    })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'VERSION_CONFLICT',
    )
    expect((await getMe(jar)).timezone).toBe('Asia/Tokyo')
  })

  test('two concurrent writes from the same version: exactly one wins', async () => {
    const { jar } = await signedIn()
    const before = await getMe(jar)
    const results = await Promise.all(
      ['Asia/Tokyo', 'Europe/Paris', 'America/Chicago', 'Australia/Sydney'].map((timezone) =>
        patch(jar, { expectedMeVersion: before.meVersion, timezone }),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409])
    expect((await getMe(jar)).meVersion).toBe(before.meVersion + 1)
  })

  test('rejects an unknown zone, an empty change, extra fields and anonymous callers', async () => {
    const { jar } = await signedIn()
    const { meVersion } = await getMe(jar)
    for (const body of [
      { expectedMeVersion: meVersion, timezone: 'Mars/Olympus_Mons' },
      { expectedMeVersion: meVersion },
      { expectedMeVersion: meVersion, timezone: 'Asia/Tokyo', role: 'admin' },
      { expectedMeVersion: meVersion, settings: { role: 'admin' } },
      { timezone: 'Asia/Tokyo' },
    ]) {
      expect((await patch(jar, body)).status).toBe(422)
    }
    expect(
      (await patch(app.newJar(), { expectedMeVersion: 1, timezone: 'Asia/Tokyo' })).status,
    ).toBe(401)
    expect((await getMe(jar)).meVersion).toBe(meVersion)
  })
})
