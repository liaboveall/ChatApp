import { expect, test } from '../e2e/support/fixtures.ts'
import { CSP, SECURITY_HEADERS } from '../tools/csp.ts'
import { raw, request } from './support.ts'

/**
 * AT-19 at the gateway (docs/08, docs/10 section 5, D-045, D-072): the right security headers on every kind of location
 * and on the errors Nginx answers itself, each exactly once. Nginx adds the transport header everywhere it answers and the
 * page policy with its companions on what it serves from disk; on /api and /ws only the transport header is Nginx's, the
 * rest belongs to the application (no duplicates).
 */
const count = (headers: Array<{ name: string }>, name: string): number =>
  headers.filter((header) => header.name.toLowerCase() === name).length
const value = (headers: Array<{ name: string; value: string }>, name: string): string | undefined =>
  headers.find((header) => header.name.toLowerCase() === name)?.value

const HSTS = 'max-age=31536000'

test.describe('static locations', () => {
  const documents = [
    '/',
    '/index.html',
    '/login',
    '/c/00000000-0000-4000-8000-000000000000',
    '/join',
  ]

  for (const path of documents) {
    test(`the document at ${path}: the page policy and companions once, HSTS once, never cached`, async ({
      request: client,
    }) => {
      const response = await client.get(path)
      expect(response.status()).toBe(200)
      const headers = response.headersArray()
      for (const [name, expected] of Object.entries(SECURITY_HEADERS)) {
        expect(count(headers, name.toLowerCase()), name).toBe(1)
        expect(value(headers, name.toLowerCase())).toBe(expected)
      }
      expect(count(headers, 'strict-transport-security')).toBe(1)
      expect(value(headers, 'strict-transport-security')).toBe(HSTS)
      expect(value(headers, 'cache-control')).toBe('no-cache')
      expect(response.headers()['content-type']).toContain('text/html')
      expect(response.headers().server).toBe('nginx')
    })
  }

  test('a file of the build that is not hashed is the file, with the same headers', async ({
    request: client,
  }) => {
    const response = await client.get('/theme-init.js')
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('javascript')
    expect(value(response.headersArray(), 'content-security-policy')).toBe(CSP)
    expect(count(response.headersArray(), 'strict-transport-security')).toBe(1)
  })

  test('a hashed asset is immutable for a year and carries the policy; a missing one is a real 404, not the page', async ({
    request: client,
  }) => {
    const page = await (await client.get('/')).text()
    const asset = /\/assets\/[^"']+\.js/.exec(page)?.[0]
    if (asset === undefined) throw new Error('the page names no script')
    const found = await client.get(asset)
    expect(found.status()).toBe(200)
    expect(value(found.headersArray(), 'cache-control')).toBe('public, max-age=31536000, immutable')
    expect(value(found.headersArray(), 'content-security-policy')).toBe(CSP)
    expect(count(found.headersArray(), 'strict-transport-security')).toBe(1)

    const missing = await client.get('/assets/does-not-exist-0000.js')
    expect(missing.status()).toBe(404)
    expect(await missing.text()).not.toContain('<div id="root">')
    // A 404 is not cached for a year, and still carries the transport header and the policy.
    expect(value(missing.headersArray(), 'cache-control') ?? '').not.toContain('immutable')
    expect(count(missing.headersArray(), 'strict-transport-security')).toBe(1)
    expect(count(missing.headersArray(), 'content-security-policy')).toBe(1)
  })

  test("Vite's own files are not in the web root", async ({ request: client }) => {
    const response = await client.get('/.vite/manifest.json')
    // The SPA fallback answers (it is the page, not a manifest) or it is a 404: never a JSON manifest.
    expect(response.headers()['content-type'] ?? '').not.toContain('json')
  })
})

test.describe('the API and the socket', () => {
  for (const [path, status] of [
    ['/api/readyz', 200],
    ['/api/me', 401],
  ] as const) {
    test(`${path} (${status}): HSTS from the gateway once; everything else from the application once`, async ({
      request: client,
    }) => {
      const response = await client.get(path)
      expect(response.status()).toBe(status)
      const headers = response.headersArray()
      expect(count(headers, 'strict-transport-security')).toBe(1)
      expect(value(headers, 'strict-transport-security')).toBe(HSTS)
      // The application's: no store, no sniffing, no referrer, an API policy that allows nothing.
      for (const name of [
        'cache-control',
        'x-content-type-options',
        'referrer-policy',
        'cross-origin-resource-policy',
      ]) {
        expect(count(headers, name), name).toBe(1)
      }
      expect(value(headers, 'cache-control')).toBe('no-store')
      expect(count(headers, 'content-security-policy')).toBe(1)
      expect(value(headers, 'content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      )
      // Nothing the gateway adds to its static answers is on an API answer.
      expect(count(headers, 'cross-origin-opener-policy')).toBe(0)
      expect(count(headers, 'permissions-policy')).toBe(0)
      expect(count(headers, 'x-request-id')).toBe(1)
    })
  }

  test('the socket answers through the gateway: an anonymous connection ends with 4401, a foreign origin with 4403', async ({
    page,
  }) => {
    await page.goto('/login')
    const code = (target: string): Promise<number> =>
      page.evaluate(
        (url) =>
          new Promise<number>((resolve) => {
            const socket = new WebSocket(url)
            socket.onclose = (event) => resolve(event.code)
          }),
        target,
      )
    expect(await code('wss://chat.localhost:8443/ws')).toBe(4401)
    // The same gateway under its address instead of its name: the page's origin is not the site.
    await page.goto('https://127.0.0.1:8443/login')
    expect(await code('wss://127.0.0.1:8443/ws')).toBe(4403)
  })
})

test.describe('errors the gateway answers itself', () => {
  test('too large a body: 413 with the transport header, once', async ({ request: client }) => {
    const response = await client.post('/api/conversations', {
      headers: { 'content-type': 'application/json' },
      data: Buffer.alloc(200_000, 0x61),
    })
    expect(response.status()).toBe(413)
    expect(count(response.headersArray(), 'strict-transport-security')).toBe(1)
    expect(response.headers().server).toBe('nginx')
  })

  test('a request the gateway cannot parse: 400, and the transport header is still there', async () => {
    const answer = await raw([request('GET', '/%zz')])
    expect(answer.status).toBe(400)
    expect(answer.headers['strict-transport-security']).toEqual([HSTS])
    // No version of the server and no path in what it says.
    expect(answer.text).not.toMatch(/nginx\/\d/)
  })
})
