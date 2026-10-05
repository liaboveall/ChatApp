/** SEC-29: test-only endpoints exist only in the test environment, and production refuses to start if any slipped in. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AppError } from '@chatapp/contracts'
import { createApp } from '../../src/http/app.ts'
import { assertNoTestRoutes, TEST_ROUTE_PREFIX } from '../../src/http/routes/test.ts'
import { openTestDatabases, type TestDatabases } from '../support/db.ts'
import { createTestApp } from '../support/http.ts'

let dbs: TestDatabases
beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await dbs.close()
})

describe('test-only routes', () => {
  test('the test environment serves a controllable clock', async () => {
    const app = await createTestApp(dbs)
    const before = new Date(
      ((await (await app.request('/api/test/clock')).json()) as { now: string }).now,
    ).getTime()
    const moved = await app.request('/api/test/clock', { json: { advanceMs: 3_600_000 } })
    expect(moved.status).toBe(200)
    const after = new Date(((await moved.json()) as { now: string }).now).getTime()
    expect(after - before).toBe(3_600_000)
    expect(app.clock.now().getTime()).toBe(after)
    await app.close()
  })

  test('a production app has none, serves no API docs, and passes the start-up self-check', async () => {
    const testApp = await createTestApp(dbs)
    const production = createApp({
      ...testApp.services,
      config: { ...testApp.services.config, env: 'production' },
    })
    expect(() => assertNoTestRoutes(production)).not.toThrow()
    expect(production.routes.some((route) => route.path.startsWith(TEST_ROUTE_PREFIX))).toBe(false)
    const docs = await production.request(
      'http://localhost:5173/api/docs',
      {},
      { peerAddress: () => '127.0.0.1' },
    )
    const spec = await production.request(
      'http://localhost:5173/api/openapi.json',
      {},
      { peerAddress: () => '127.0.0.1' },
    )
    expect(docs.status).toBe(404)
    expect(spec.status).toBe(404)
    const clock = await production.request(
      'http://localhost:5173/api/test/clock',
      {},
      { peerAddress: () => '127.0.0.1' },
    )
    expect(clock.status).toBe(404)
    // The routes M2b added (D-155) are absent too.
    const aged = await production.request(
      `http://localhost:5173/api/test/messages/${crypto.randomUUID()}/age`,
      {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: JSON.stringify({ ms: 1000 }),
      },
      { peerAddress: () => '127.0.0.1' },
    )
    expect(aged.status).toBe(404)
    const ip = await production.request(
      'http://localhost:5173/api/test/client-ip',
      {},
      { peerAddress: () => '127.0.0.1' },
    )
    expect(ip.status).toBe(404)
    await testApp.close()
  })

  test('the self-check throws when a test route is present', async () => {
    const testApp = await createTestApp(dbs)
    expect(() => assertNoTestRoutes(createApp(testApp.services))).toThrow(AppError)
    await testApp.close()
  })
})
