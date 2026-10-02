/**
 * Request-boundary security (SEC-13, SEC-19, SEC-38; AT-26, AT-27, AT-04): what the HTTP layer refuses before any
 * business code runs, and what it never writes to its logs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sessions, users, verifications } from '@chatapp/db'
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
  app = await createTestApp(dbs, {
    appOptions: { bodyBudget: { maxBytes: 128 * 1024, totalMs: 1_000, idleMs: 150 } },
  })
})
afterEach(async () => {
  await app.close()
})

const errorCode = async (response: Response) =>
  ((await response.clone().json()) as { error?: { code?: string } }).error?.code

describe('origin check (SEC-13)', () => {
  test('state-changing requests need exactly the site origin', async () => {
    const body = { email: 'a@example.com', password: 'whatever-password' }
    for (const origin of [
      null,
      'http://evil.example',
      'null',
      'http://localhost:5173/',
      'http://localhost:5174',
    ]) {
      const response = await app.request('/api/auth/sign-in/email', { json: body, origin })
      expect(response.status).toBe(403)
      expect(await errorCode(response)).toBe('FORBIDDEN')
    }
    // Reads do not need one.
    expect((await app.request('/api/healthz', { origin: null })).status).toBe(200)
  })
})

describe('request budget before parsing (D-078, AT-27)', () => {
  const post = (body: Parameters<TestApp['request']>[1]) =>
    app.request('/api/invites/check', { ...body })

  test('the JSON limit is exact: 128 KiB reaches validation, one byte more is refused unparsed', async () => {
    const fill = (size: number) => {
      const prefix = '{"code":"'
      const suffix = '"}'
      return prefix + 'a'.repeat(size - prefix.length - suffix.length) + suffix
    }
    const atLimit = await post({
      body: fill(128 * 1024),
      headers: { 'content-type': 'application/json' },
    })
    expect(atLimit.status).toBe(422) // parsed and validated (code too long), not a size error
    const over = await post({
      body: fill(128 * 1024 + 1),
      headers: { 'content-type': 'application/json' },
    })
    expect(over.status).toBe(413)
    expect(await errorCode(over)).toBe('PAYLOAD_TOO_LARGE')
  })

  test('a streamed body without Content-Length is counted and the stream is cancelled', async () => {
    let cancelled = false
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1
        controller.enqueue(new TextEncoder().encode('x'.repeat(16 * 1024)))
        if (sent > 64) controller.close() // would be 1 MiB if nobody stopped it
      },
      cancel() {
        cancelled = true
      },
    })
    const response = await post({ body: stream, headers: { 'content-type': 'application/json' } })
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(sent).toBeLessThan(20)
  })

  test('a stalled sender is cut off at the idle limit', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"code":'))
        // never sends more, never closes
      },
    })
    const response = await post({ body: stream, headers: { 'content-type': 'application/json' } })
    expect(response.status).toBe(408)
    expect(await errorCode(response)).toBe('REQUEST_TIMEOUT')
  })

  test('compressed bodies, other content types and other charsets are refused', async () => {
    const json = '{"code":"x"}'
    expect(
      (
        await post({
          body: json,
          headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        })
      ).status,
    ).toBe(415)
    expect((await post({ body: json, headers: { 'content-type': 'text/plain' } })).status).toBe(415)
    expect(
      (
        await post({
          body: 'code=x',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
      ).status,
    ).toBe(415)
    expect(
      (await post({ body: json, headers: { 'content-type': 'application/json; charset=latin1' } }))
        .status,
    ).toBe(415)
    expect(
      (await post({ body: json, headers: { 'content-type': 'application/json; charset=utf-8' } }))
        .status,
    ).toBe(400) // reaches the handler: INVITE_INVALID
  })

  test('framing that contradicts itself is refused', async () => {
    const both = await post({
      body: '{"code":"x"}',
      headers: {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
        'content-length': '12',
      },
    })
    expect(both.status).toBe(400)
    expect(await errorCode(both)).toBe('INVALID_REQUEST_FRAMING')
    const garbage = await post({
      body: '{"code":"x"}',
      headers: { 'content-type': 'application/json', 'content-length': '12abc' },
    })
    expect(garbage.status).toBe(400)
  })

  test('malformed JSON and invalid UTF-8 are validation errors, with nothing echoed back', async () => {
    const malformed = await post({
      body: '{"code": SENTINEL-NOT-JSON',
      headers: { 'content-type': 'application/json' },
    })
    expect(malformed.status).toBe(422)
    expect(await malformed.clone().text()).not.toContain('SENTINEL')
    const bytes = new Uint8Array([0x7b, 0x22, 0x63, 0x22, 0x3a, 0xff, 0xfe, 0x7d])
    const invalidUtf8 = await post({ body: bytes, headers: { 'content-type': 'application/json' } })
    expect(invalidUtf8.status).toBe(422)
  })

  test('after refusing hostile requests the service still answers normal ones', async () => {
    await post({ body: 'x'.repeat(200 * 1024), headers: { 'content-type': 'application/json' } })
    const ok = await post({ json: { code: 'AAAA-AAAA-AAAA-AAAA' } })
    expect(ok.status).toBe(400)
    expect(await errorCode(ok)).toBe('INVITE_INVALID')
  })
})

describe('path guard', () => {
  test('encoded and doubled-slash paths never reach a router', async () => {
    for (const path of [
      '/api/healthz/',
      '/api//healthz',
      '/api/%68ealthz',
      '/api/auth/sign%2Din/email',
    ]) {
      const response = await app.request(path, { method: 'GET' })
      expect(response.status, path).toBe(404)
    }
  })

  test('dot segments and backslashes are normalized by the URL parser before any router sees them', async () => {
    // Every layer receives the same normalized URL, so there is no parsing differential to exploit: such a request is
    // simply a request for the canonical path, and the allowlist applies to that canonical path.
    expect((await app.request('/api/./healthz')).status).toBe(200)
    for (const path of [
      '/api/auth/./update-user',
      '/api/auth/../auth/update-user',
      '/api/auth\\update-user',
    ]) {
      const response = await app.request(path, { method: 'POST', json: {} })
      expect(response.status, path).toBe(404)
    }
  })
})

describe('security headers and error format', () => {
  test('every API response is uncacheable, unsniffable, unframed and carries a server-generated request id', async () => {
    const responses = [
      await app.request('/api/healthz'),
      await app.request('/api/nope'),
      await app.request('/api/me'), // 401
      await app.request('/api/invites/check', { json: { code: 'x' } }), // 400
    ]
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    }
    const spoofed = await app.request('/api/healthz', {
      headers: { 'x-request-id': 'client-chosen' },
    })
    expect(spoofed.headers.get('x-request-id')).not.toBe('client-chosen')
  })

  test('errors use the unified body; unknown routes are 404; a 500 reveals nothing', async () => {
    const notFound = await app.request('/api/nope')
    expect(notFound.status).toBe(404)
    const body = (await notFound.json()) as {
      error: { code: string; message: string; requestId: string }
    }
    expect(body.error).toMatchObject({ code: 'NOT_FOUND' })
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/)

    // Force an unexpected failure inside a handler: the response carries only the code and the request id.
    const admin = await createActiveUser(app.services.deps, { username: 'boss', role: 'admin' })
    const jar = app.newJar()
    await app.request('/api/auth/sign-in/email', {
      json: { email: admin.email, password: admin.password },
      jar,
    })
    const invite = (await (await app.request('/api/invites', { json: {}, jar })).json()) as {
      code: string
    }
    // Replace hashing on THIS app's dependencies only (the real hasher object is shared between tests).
    app.services.deps.passwords = {
      ...app.services.deps.passwords,
      hash: async () => {
        throw new Error('SENTINEL-INTERNAL: connection string postgres://user:SENTINEL@db')
      },
    }
    const failed = await app.request('/api/auth/sign-up/email', {
      json: {
        email: 'x@example.com',
        username: 'xuser',
        name: 'X',
        password: 'tomato-umbrella-47-lantern',
      },
      headers: { 'x-invite-code': invite.code, 'idempotency-key': 'k' },
    })
    expect(failed.status).toBe(500)
    const text = await failed.text()
    expect(text).not.toContain('SENTINEL')
    expect(text).not.toMatch(/stack|at .*\.ts/i)
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('INTERNAL')
  })
})

describe('rate limiting (SEC-11)', () => {
  test('repeated sign-in attempts for one account hit 429 with Retry-After', async () => {
    const statuses: number[] = []
    let last: Response | undefined
    for (let i = 0; i < 10; i += 1) {
      last = await app.request('/api/auth/sign-in/email', {
        json: { email: 'victim@example.com', password: 'wrong-password-1' },
      })
      statuses.push(last.status)
    }
    expect(statuses.slice(0, 8).every((status) => status === 401)).toBe(true)
    expect(statuses.slice(8)).toEqual([429, 429])
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(await errorCode(last as Response)).toBe('RATE_LIMITED')
  })

  test('the per-IP limit holds across different accounts, and a forged X-Forwarded-For from an untrusted peer changes nothing', async () => {
    let limited = 0
    for (let i = 0; i < 24; i += 1) {
      const response = await app.request('/api/auth/sign-in/email', {
        json: { email: `user${i}@example.com`, password: 'wrong-password-1' },
        peer: '203.0.113.50',
        forwardedFor: `198.51.100.${i}`, // ignored: the peer is not a trusted proxy
      })
      if (response.status === 429) limited += 1
    }
    expect(limited).toBe(4) // 20 allowed per IP group, the rest refused

    // Behind a trusted proxy the forwarded client address is what counts.
    const other = await app.request('/api/auth/sign-in/email', {
      json: { email: 'fresh@example.com', password: 'wrong-password-1' },
      peer: '127.0.0.1',
      forwardedFor: '198.51.100.99',
    })
    expect(other.status).toBe(401)
  })

  test('anonymous request endpoints answer identically and are limited per account digest', async () => {
    const known = await createActiveUser(app.services.deps, { username: 'known' })
    const attempts = async (email: string) => {
      const out: number[] = []
      for (let i = 0; i < 5; i += 1) {
        out.push(
          (await app.request('/api/auth/password/request-reset', { json: { email } })).status,
        )
      }
      return out
    }
    const forKnown = await attempts(known.email)
    const forUnknown = await attempts('nobody@example.com')
    expect(forKnown).toEqual([202, 202, 202, 429, 429])
    expect(forUnknown).toEqual(forKnown)
  })
})

describe('response time of anonymous request endpoints does not depend on the account', () => {
  test('known and unknown emails take at least the same padded time', async () => {
    const known = await createActiveUser(app.services.deps, { username: 'timed' })
    const time = async (email: string) => {
      const started = performance.now()
      await app.request('/api/auth/verification/request', { json: { email } })
      return performance.now() - started
    }
    const [a, b] = [await time(known.email), await time('nobody@example.com')]
    expect(a).toBeGreaterThanOrEqual(280)
    expect(b).toBeGreaterThanOrEqual(280)
  })
})

describe('logs never contain request secrets (D-077, AT-26)', () => {
  test('sentinels in body, query, path, headers, cookies and fragments never reach a log line', async () => {
    const sentinel = 'SENTINEL-7f3a9c'
    const user = await createActiveUser(app.services.deps, { username: 'logged' })
    const jar = app.newJar()
    await app.request('/api/auth/sign-in/email', {
      json: { email: user.email, password: user.password },
      jar,
    })
    const requests: Array<Promise<Response>> = [
      app.request(`/api/nope/${sentinel}?token=${sentinel}&email=${sentinel}%40example.com`, {
        headers: { authorization: `Bearer ${sentinel}`, referer: `http://x/?t=${sentinel}` },
      }),
      app.request('/api/auth/sign-in/email', {
        json: { email: `${sentinel}@example.com`, password: sentinel },
        headers: { cookie: `x=${sentinel}`, 'user-agent': `agent ${sentinel}` },
      }),
      app.request('/api/auth/verification/consume', { json: { token: sentinel.padEnd(43, 'x') } }),
      app.request('/api/auth/password/consume-reset', {
        json: { token: 'A'.repeat(43), newPassword: `${sentinel}-password` },
      }),
      app.request('/api/invites/check', {
        json: { code: sentinel },
        headers: { 'x-invite-code': sentinel },
      }),
      app.request('/api/invites/check', {
        body: `{"code": ${sentinel}`,
        headers: { 'content-type': 'application/json' },
      }),
      app.request('/api/invites/check', {
        body: 'x'.repeat(200 * 1024),
        headers: { 'content-type': 'application/json' },
      }),
      app.request('/api/invites/check', {
        body: sentinel,
        headers: { 'content-type': 'text/plain' },
      }),
      app.request(`/api/auth/sign-in/email`, {
        json: { email: 'a@example.com', password: sentinel, extra: sentinel },
        origin: `http://${sentinel}.example`,
      }),
      app.request('/api/me', { jar }),
    ]
    const statuses = (await Promise.all(requests)).map((response) => response.status)
    expect(new Set(statuses).size).toBeGreaterThanOrEqual(5) // 200/400/401/403/404/413/415/422 all exercised

    expect(app.logs.length).toBeGreaterThan(0)
    for (const line of app.logs) {
      expect(line).not.toContain(sentinel)
      const record = JSON.parse(line) as Record<string, unknown>
      expect(
        Object.keys(record).every((key) =>
          [
            'level',
            'time',
            'service',
            'msg',
            'requestId',
            'route',
            'method',
            'status',
            'durationMs',
            'ip',
            'userId',
            'errorName',
            'errorCode',
            'constraint',
            'stackFrames',
          ].includes(key),
        ),
      ).toBe(true)
      if (typeof record.route === 'string') expect(record.route).not.toContain('SENTINEL')
    }
    // Unknown paths are logged as "unknown", never as the path itself.
    const unknown = app.logs
      .map((line) => JSON.parse(line) as { route?: string; status?: number })
      .filter((r) => r.status === 404)
    expect(unknown.length).toBeGreaterThan(0)
    expect(unknown.every((r) => r.route === 'unknown')).toBe(true)
  })
})

describe('what the SDK could have created stays empty', () => {
  test('the failed attempts above left no accounts or sessions or challenge rows behind', async () => {
    await app.request('/api/auth/sign-up/email', {
      json: {
        email: 'x@example.com',
        username: 'xuser',
        name: 'X',
        password: 'tomato-umbrella-47-lantern',
      },
      headers: { 'idempotency-key': 'k' },
    })
    expect(await dbs.owner.db.select().from(users)).toHaveLength(0)
    expect(await dbs.owner.db.select().from(sessions)).toHaveLength(0)
    expect(await dbs.owner.db.select().from(verifications)).toHaveLength(0)
  })
})
