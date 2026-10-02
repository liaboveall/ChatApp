/** The OpenAPI document is generated from the routes and committed; interface changes must be deliberate (docs/08 section 2). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createApp } from '../../src/http/app.ts'
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

describe('OpenAPI document', () => {
  test('matches the committed snapshot and describes only public API paths', async () => {
    const testApp = await createTestApp(dbs)
    const app = createApp({
      ...testApp.services,
      config: { ...testApp.services.config, env: 'development' },
    })
    const document = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'ChatApp API', version: '1.0.0' },
    })
    await testApp.close()

    const paths = Object.keys(document.paths ?? {})
    expect(paths.length).toBeGreaterThan(10)
    expect(paths.every((path) => path.startsWith('/api/'))).toBe(true)
    // Test-only endpoints are not part of the contract.
    expect(paths.some((path) => path.startsWith('/api/test'))).toBe(false)
    expectSnapshot(join(import.meta.dir, 'openapi.snapshot.json'), document)
  })

  test('development serves the interactive docs page and the document; the page has its own CSP', async () => {
    const testApp = await createTestApp(dbs)
    const app = createApp({
      ...testApp.services,
      config: { ...testApp.services.config, env: 'development' },
    })
    const env = { peerAddress: () => '127.0.0.1' }
    const page = await app.request('http://localhost:5173/api/docs', {}, env)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('content-security-policy')).toContain('cdn.jsdelivr.net')
    expect(await page.text()).toContain('/api/openapi.json')
    const spec = await app.request('http://localhost:5173/api/openapi.json', {}, env)
    expect(spec.status).toBe(200)
    expect(Object.keys(((await spec.json()) as { paths: object }).paths).length).toBeGreaterThan(10)
    await testApp.close()
  })
})
