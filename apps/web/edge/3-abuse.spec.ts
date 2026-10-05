import { gzipSync } from 'node:zlib'
import { expect, test } from '../e2e/support/fixtures.ts'
import { apiLog, gatewayLog, raw, request, sentinel } from './support.ts'

/**
 * The gateway's part of AT-26 and AT-27 (docs/08, docs/10 section 5, docs/12 D-147): requests that are too large, too
 * slow, malformed or compressed are refused by the gateway before the application reads them, with bounded answers; and
 * what was in a request (a made-up secret in the path, the query, a header, the body) is in no log, while the request
 * id still ties a line of the gateway's log to the application's. Real secrets are never used.
 */
const HSTS = 'max-age=31536000'
const KIB = 1024

/** A JSON body of exactly `bytes` bytes for the sign-in endpoint (the content is a made-up login, never a real one). */
function loginBody(bytes: number): string {
  const head = '{"email":"nobody@example.test","password":"'
  const tail = '"}'
  const pad = bytes - Buffer.byteLength(head) - Buffer.byteLength(tail)
  return `${head}${'a'.repeat(pad)}${tail}`
}

test.describe('size', () => {
  test('a JSON body of exactly 128 KiB goes through to the application; one byte more is refused by the gateway', async () => {
    const exact = loginBody(128 * KIB)
    expect(Buffer.byteLength(exact)).toBe(128 * KIB)
    const passed = await raw([
      request(
        'POST',
        '/api/auth/sign-in/email',
        { 'Content-Type': 'application/json', Origin: 'https://chat.localhost:8443' },
        exact,
      ),
    ])
    // The application answered (it is a wrong login, or a body it refuses to read): not the gateway's 413.
    expect(passed.status).not.toBeNull()
    expect(passed.status).not.toBe(413)
    expect(passed.headers['x-request-id']?.length).toBe(1)

    const over = await raw([
      request(
        'POST',
        '/api/auth/sign-in/email',
        { 'Content-Type': 'application/json', Origin: 'https://chat.localhost:8443' },
        loginBody(128 * KIB + 1),
      ),
    ])
    expect(over.status).toBe(413)
    // The gateway answered itself: no request id of the application, the transport header, a bounded body.
    expect(over.headers['x-request-id']).toBeUndefined()
    expect(over.headers['strict-transport-security']).toEqual([HSTS])
    expect(over.text.length).toBeLessThan(2_000)
  })

  test('a body that arrives in chunks is counted as it arrives: 413 once it is too long', async () => {
    const chunk = 'a'.repeat(32 * KIB)
    const framed = (data: string): string => `${data.length.toString(16)}\r\n${data}\r\n`
    const head = [
      'POST /api/conversations HTTP/1.1',
      'Host: chat.localhost:8443',
      'Content-Type: application/json',
      'Transfer-Encoding: chunked',
      'Connection: close',
      '',
      '',
    ].join('\r\n')
    const answer = await raw([head, ...Array.from({ length: 6 }, () => framed(chunk)), '0\r\n\r\n'])
    expect(answer.status).toBe(413)
    expect(answer.headers['strict-transport-security']).toEqual([HSTS])
  })

  test('a request header that is too large is refused', async () => {
    const answer = await raw([request('GET', '/api/me', { 'X-Pad': 'a'.repeat(9 * KIB) })])
    expect([400, 431]).toContain(answer.status ?? 0)
  })
})

test.describe('time', () => {
  test('a request whose body never finishes is dropped within a few seconds: no answer bytes, a 408 in the log', async () => {
    const answer = await raw(
      [
        [
          'POST /api/auth/sign-in/email HTTP/1.1',
          'Host: chat.localhost:8443',
          'Content-Type: application/json',
          'Content-Length: 200',
          'Origin: https://chat.localhost:8443',
          '',
          '{"email":',
        ].join('\r\n'),
      ],
      { waitMs: 12_000 },
    )
    expect(answer.closed).toBe(true)
    // `client_body_timeout 5s`: the connection ends shortly after that, and nothing that looks like a response was sent.
    expect(answer.elapsedMs).toBeGreaterThanOrEqual(4_500)
    expect(answer.elapsedMs).toBeLessThan(9_000)
    expect(answer.text).toBe('')
    expect(gatewayLog()).toMatch(/ 408 /)
  })

  test('while one request is being held open, small requests are still served', async () => {
    const held = raw(
      [
        [
          'POST /api/auth/sign-in/email HTTP/1.1',
          'Host: chat.localhost:8443',
          'Content-Length: 100',
          'Content-Type: application/json',
          '',
          '{',
        ].join('\r\n'),
      ],
      { waitMs: 7_000 },
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    const small = await raw([request('GET', '/api/readyz')])
    expect(small.status).toBe(200)
    await held
  })
})

test.describe('framing and compression', () => {
  test('both a length and chunked framing: 400', async () => {
    const answer = await raw([
      [
        'POST /api/auth/sign-in/email HTTP/1.1',
        'Host: chat.localhost:8443',
        'Content-Type: application/json',
        'Content-Length: 5',
        'Transfer-Encoding: chunked',
        'Connection: close',
        '',
        '0',
        '',
        '',
      ].join('\r\n'),
    ])
    expect(answer.status).toBe(400)
  })

  test('two different lengths: 400', async () => {
    const answer = await raw([
      [
        'POST /api/auth/sign-in/email HTTP/1.1',
        'Host: chat.localhost:8443',
        'Content-Type: application/json',
        'Content-Length: 2',
        'Content-Length: 4',
        'Connection: close',
        '',
        '{}',
      ].join('\r\n'),
    ])
    expect(answer.status).toBe(400)
  })

  test('a compressed request body is refused before it is read: 415, bounded', async () => {
    const body = gzipSync(Buffer.from(loginBody(2 * KIB)))
    const head = [
      'POST /api/auth/sign-in/email HTTP/1.1',
      'Host: chat.localhost:8443',
      'Origin: https://chat.localhost:8443',
      'Content-Type: application/json',
      'Content-Encoding: gzip',
      `Content-Length: ${body.length}`,
      'Connection: close',
      '',
      '',
    ].join('\r\n')
    const answer = await raw([head, body.toString('latin1')])
    expect(answer.status).toBe(415)
    expect(answer.text.length).toBeLessThan(4_000)
  })
})

test.describe('nothing of a request is logged', () => {
  test('a made-up secret in the path, query, headers, cookie and body appears in no log, and the request id still ties the logs together', async () => {
    const path = sentinel('path')
    const query = sentinel('query')
    const header = sentinel('header')
    const cookie = sentinel('cookie')
    const referer = sentinel('referer')
    const agent = sentinel('agent')
    const body = sentinel('body')
    const answers = [
      await raw([
        request('GET', `/api/${path}`, {
          'X-Test': header,
          Cookie: `x=${cookie}`,
          Referer: `https://example.test/${referer}`,
          'User-Agent': agent,
        }),
      ]),
      await raw([request('GET', `/api/me?search=${query}`, { Authorization: `Bearer ${header}` })]),
      await raw([
        request(
          'POST',
          '/api/auth/sign-in/email',
          { 'Content-Type': 'application/json', Origin: 'https://chat.localhost:8443' },
          JSON.stringify({ email: 'nobody@example.test', password: body }),
        ),
      ]),
      await raw([request('GET', `/${path}`)]),
      await raw([request('GET', `/assets/${path}.js`)]),
    ]
    // Something answered every one of them.
    for (const answer of answers) expect(answer.status).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    const gateway = gatewayLog()
    const application = apiLog()
    for (const secret of [path, query, header, cookie, referer, agent, body]) {
      expect(gateway, 'the gateway log').not.toContain(secret)
      expect(application, 'the API log').not.toContain(secret)
    }
    // The API's answer to an unknown path carries a request id; the same id is in both logs.
    const id = answers[0]?.headers['x-request-id']?.[0]
    expect(id).toBeTruthy()
    expect(gateway).toContain(id as string)
    expect(application).toContain(id as string)
  })
})

// Last on purpose: the burst leaves the gateway's limiter for authentication paths saturated for a minute.
test.describe('limits', () => {
  test('a burst against an authentication location is cut off by the gateway with 429, and the rest of the site stays up', async () => {
    const answers = await Promise.all(
      Array.from({ length: 160 }, () =>
        raw([request('GET', '/api/invites/check?code=nope')], { waitMs: 8_000 }),
      ),
    )
    const refused = answers.filter((answer) => answer.status === 429)
    expect(refused.length).toBeGreaterThan(0)
    // The gateway's own refusals carry the transport header and no application request id.
    const own = refused.filter((answer) => answer.headers['x-request-id'] === undefined)
    expect(own.length).toBeGreaterThan(0)
    for (const answer of own) expect(answer.headers['strict-transport-security']).toEqual([HSTS])
    // A small request elsewhere is served at once.
    const small = await raw([request('GET', '/api/readyz')])
    expect(small.status).toBe(200)
  })
})
