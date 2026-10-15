import { afterAll, beforeAll, expect, test } from 'bun:test'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'

let dbs: TestDatabases, app: TestApp
beforeAll(async () => {
  dbs = openTestDatabases()
  await truncateAll(dbs.owner)
  app = await createTestApp(dbs)
})
afterAll(async () => {
  await app.close()
  await truncateAll(dbs.owner)
  await dbs.close()
})
test('the public relay has no session or cookie effects, rejects private fields and respects origin and IP limits', async () => {
  const events: unknown[] = []
  app.services.monitoring = {
    enabled: true,
    send: async (event) => {
      events.push(event)
    },
  }
  const response = await app.request('/api/monitoring', {
    json: { kind: 'TypeError', page: 'auth' },
    headers: { cookie: 'arbitrary=session' },
  })
  expect(response.status).toBe(200)
  expect(response.headers.getSetCookie()).toEqual([])
  expect(events).toEqual([{ kind: 'TypeError', page: 'auth' }])
  expect(
    (
      await app.request('/api/monitoring', {
        json: { kind: 'Error', page: 'chat', message: 'private-relay-canary' },
      })
    ).status,
  ).toBe(422)
  expect(
    (
      await app.request('/api/monitoring', {
        origin: 'https://evil.invalid',
        json: { kind: 'Error', page: 'chat' },
      })
    ).status,
  ).toBe(403)
  for (let i = 0; i < 19; i++)
    expect(
      (await app.request('/api/monitoring', { json: { kind: 'Error', page: 'chat' } })).status,
    ).toBe(200)
  expect(
    (await app.request('/api/monitoring', { json: { kind: 'Error', page: 'chat' } })).status,
  ).toBe(429)
  expect(events).toHaveLength(20)
  expect(app.logs.join('\n')).not.toContain('private-relay-canary')
})
test('upstream failure returns a sanitized unavailable response without session effects', async () => {
  app.services.monitoring = {
    enabled: true,
    send: async () => {
      throw new Error('private-upstream-canary')
    },
  }
  const response = await app.request('/api/monitoring', {
    json: { kind: 'Error', page: 'public' },
    forwardedFor: '10.99.1.3',
  })
  expect(response.status).toBe(503)
  expect(response.headers.getSetCookie()).toEqual([])
  expect(await response.text()).not.toContain('private-upstream-canary')
  expect(app.logs.join('\n')).not.toContain('private-upstream-canary')
})
