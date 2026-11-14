/**
 * One request is authenticated once. Hono's `/api/x/*` also matches `/api/x`, so a module that registers the session guard
 * for both, or for a path another module already covers, would read the session again and count the request a second
 * time against the person's API limit. The counters of the limiter make that visible: every guarded request must add
 * exactly one hit to `api.user`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { LIMITS } from '@chatapp/contracts'
import { sessions } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { type Person, person } from '../support/people.ts'

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

/** How often the limiter counted this person under a policy, in this test application. */
async function hits(policy: string, who: Person): Promise<number> {
  const keys = await app.valkey.keys(`rl:test-http-*:${policy}:${who.id}`)
  expect(keys.length).toBeLessThanOrEqual(1)
  const key = keys[0]
  return key ? Number(await app.valkey.get(key)) : 0
}

type Operation = { security?: Record<string, string[]>[] }

/** Every documented GET that needs a session, with a random id in each path parameter. */
function guardedReads(): string[] {
  const document = app.app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'ChatApp API', version: '1.0.0' },
  })
  const paths: string[] = []
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    const operation = (item as { get?: Operation }).get
    if (!operation?.security?.some((entry) => 'cookieAuth' in entry)) continue
    paths.push(path.replaceAll(/\{[A-Za-z]+\}/g, () => crypto.randomUUID()))
  }
  return paths
}

test('every guarded read counts once against the per-person API limit', async () => {
  const alice = await person(app, 'alice', { role: 'admin' })
  const paths = guardedReads()
  // The collection roots are the paths two patterns used to match; they must be part of what is measured.
  for (const root of [
    '/api/me',
    '/api/conversations',
    '/api/notifications',
    '/api/users',
    '/api/reminders',
    '/api/scheduled-messages',
    '/api/me/memories',
  ])
    expect(paths).toContain(root)

  const counted: Record<string, number> = {}
  for (const path of paths) {
    const before = await hits('api.user', alice)
    const reply = await alice.get(path)
    expect(reply.status).not.toBe(401)
    counted[path] = (await hits('api.user', alice)) - before
  }
  expect(counted).toEqual(Object.fromEntries(paths.map((path) => [path, 1])))
})

test('guarded writes count once, and a memory write counts once against its own limit', async () => {
  const alice = await person(app, 'alice')
  // Invalid bodies: the guard and the limits run before validation, and nothing is written.
  const probes: Array<[method: 'post' | 'patch', path: string]> = [
    ['post', '/api/conversations'],
    ['post', '/api/me/memories'],
    ['patch', `/api/me/memories/${crypto.randomUUID()}`],
    ['post', '/api/notifications/read'],
  ]
  for (const [method, path] of probes) {
    const before = await hits('api.user', alice)
    const reply = await alice[method](path, { unexpected: true })
    expect(reply.status).toBe(422)
    expect({ path, counted: (await hits('api.user', alice)) - before }).toEqual({
      path,
      counted: 1,
    })
  }
  expect(await hits('memory-write.user', alice)).toBe(2)
})

test('a session past its refresh age is rolled forward by the guard, one cookie per name', async () => {
  const alice = await person(app, 'alice')
  // The SDK rolls a session forward once it is older than the refresh age; age this one just past it.
  const DAY = 24 * 3_600_000
  const remaining = (LIMITS.sessionTtlDays - LIMITS.sessionRefreshAgeDays) * DAY
  await dbs.owner.db
    .update(sessions)
    .set({ expiresAt: new Date(Date.now() + remaining - 3_600_000) })
    .where(eq(sessions.userId, alice.id))
  const response = await app.request('/api/me', { jar: alice.jar })
  expect(response.status).toBe(200)
  const names = response.headers.getSetCookie().map((line) => line.slice(0, line.indexOf('=')))
  expect(names.length).toBeGreaterThan(0)
  expect(new Set(names).size).toBe(names.length)
})
