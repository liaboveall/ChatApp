/**
 * Upgrading Better Auth must never open a route by accident (D-058, V-13): the SDK's exact endpoint list is committed,
 * so a new or changed endpoint fails this test and a person has to classify it. Unclassified routes are closed anyway
 * (the allowlist is exact), this test only makes the change visible.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { AUTH_ENDPOINTS } from '@chatapp/contracts'
import { openTestDatabases, type TestDatabases } from '../support/db.ts'
import { createTestApp } from '../support/http.ts'
import { expectSnapshot } from '../support/snapshot.ts'

let dbs: TestDatabases
beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await dbs.close()
})

describe('SDK endpoint inventory', () => {
  test('matches the committed snapshot, and every SDK-handled allowlist entry still exists', async () => {
    const app = await createTestApp(dbs)
    const sdk = (
      Object.values(app.services.auth.api) as Array<{
        path?: string
        options?: { method?: string | string[] }
      }>
    )
      .filter((endpoint) => endpoint.path)
      .flatMap((endpoint) => {
        const methods = endpoint.options?.method
        return (Array.isArray(methods) ? methods : [methods ?? 'GET']).map(
          (method) => `${method} /api/auth${endpoint.path}`,
        )
      })
      .sort()
    await app.close()

    expectSnapshot(join(import.meta.dir, 'auth-sdk-endpoints.snapshot.json'), sdk)

    for (const endpoint of AUTH_ENDPOINTS.filter((entry) => entry.handler === 'sdk')) {
      expect(sdk, `${endpoint.method} ${endpoint.path}`).toContain(
        `${endpoint.method} ${endpoint.path}`,
      )
    }
  })
})
