/**
 * The transport against a real TLS server on this machine (SEC-23, AT-11). The server plays the push service; the
 * connector is told to dial it whatever address it was handed, and records that address, which is how these tests prove
 * what the transport connects to: the checked address, with the host name as the name of the handshake.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type TLSSocket } from 'node:tls'
import { createEndpointPolicy, EndpointError, type Resolved } from './push-endpoints.ts'
import {
  type Connector,
  createConnector,
  createPinnedTransport,
  TransportError,
} from './push-transport.ts'

let dir: string
let cert: string
let key: string

function makeCertificate(name: string): { cert: string; key: string } {
  const base = join(dir, name.replaceAll('.', '_'))
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      `${base}.key`,
      '-out',
      `${base}.crt`,
      '-days',
      '2',
      '-subj',
      `/CN=${name}`,
      '-addext',
      `subjectAltName=DNS:${name}`,
    ],
    { stdio: 'ignore' },
  )
  return { cert: readFileSync(`${base}.crt`, 'utf8'), key: readFileSync(`${base}.key`, 'utf8') }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chatapp-push-'))
  ;({ cert, key } = makeCertificate('fcm.googleapis.com'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Received = { head: string; body: Buffer }

/** A TLS "push service": records each request and answers with whatever the test says. */
async function service(
  answer: (received: Received, socket: TLSSocket) => string | null,
  options: { cert?: string; key?: string } = {},
): Promise<{ port: number; requests: Received[]; close: () => Promise<void> }> {
  const requests: Received[] = []
  const server: Server = createServer(
    { cert: options.cert ?? cert, key: options.key ?? key },
    (socket) => {
      let buffer = Buffer.alloc(0)
      let answered = false
      socket.on('error', () => undefined)
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        const end = buffer.indexOf('\r\n\r\n')
        if (end === -1 || answered) return
        const head = buffer.subarray(0, end).toString('latin1')
        const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0)
        const body = buffer.subarray(end + 4)
        if (body.length < length) return
        answered = true
        const received = { head, body: body.subarray(0, length) }
        requests.push(received)
        const reply = answer(received, socket)
        if (reply !== null) socket.end(reply)
      })
    },
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { port, requests, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

const PUBLIC: Resolved[] = [{ address: '142.250.80.74', family: 4 }]

function transportFor(
  port: number,
  options: { answers?: Resolved[]; timeoutMs?: number; ca?: string } = {},
) {
  const dialed: Array<{ address: string; servername: string }> = []
  const inner = createConnector({ port, dial: () => '127.0.0.1', ca: options.ca ?? cert })
  const connector: Connector = (target) => {
    dialed.push({ address: target.address, servername: target.servername })
    return inner(target)
  }
  const policy = createEndpointPolicy({ lookup: async () => options.answers ?? PUBLIC })
  return {
    dialed,
    transport: createPinnedTransport({ policy, connector, timeoutMs: options.timeoutMs ?? 2000 }),
  }
}

const request = (
  extra: Partial<{ endpoint: string; headers: Record<string, string>; body: Uint8Array }> = {},
) => ({
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc?x=1',
  headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm' },
  body: Buffer.from('encrypted-bytes'),
  ...extra,
})

describe('one request, one answer', () => {
  test('writes a POST with the headers and the body, and returns the status line', async () => {
    const push = await service(
      () =>
        'HTTP/1.1 201 Created\r\nLocation: https://push.example/m/1\r\nContent-Length: 0\r\n\r\n',
    )
    const { transport } = transportFor(push.port)
    const response = await transport.post(request())
    expect(response).toEqual({ status: 201, retryAfterSeconds: null })
    expect(push.requests).toHaveLength(1)
    const head = push.requests[0]?.head ?? ''
    expect(head.split('\r\n')[0]).toBe('POST /fcm/send/abc?x=1 HTTP/1.1')
    expect(head).toContain('Host: fcm.googleapis.com')
    expect(head).toContain('TTL: 86400')
    expect(head).toContain('Urgency: high')
    expect(head).toContain('Content-Encoding: aes128gcm')
    expect(head).toContain('Content-Length: 15')
    expect(head).toContain('Connection: close')
    expect(push.requests[0]?.body.toString()).toBe('encrypted-bytes')
    await push.close()
  })

  test('connects to the address that passed the check, with the host name as the name of the handshake', async () => {
    const push = await service(() => 'HTTP/1.1 201 Created\r\n\r\n')
    const { transport, dialed } = transportFor(push.port, {
      answers: [{ address: '142.250.80.74', family: 4 }],
    })
    await transport.post(request())
    expect(dialed).toEqual([{ address: '142.250.80.74', servername: 'fcm.googleapis.com' }])
    await push.close()
  })

  test('reads the status of any answer and the retry hint of a rate limit', async () => {
    for (const [line, status] of [
      ['HTTP/1.1 410 Gone', 410],
      ['HTTP/1.1 404 Not Found', 404],
      ['HTTP/1.1 503 Service Unavailable', 503],
      ['HTTP/1.0 202 Accepted', 202],
    ] as const) {
      const push = await service(() => `${line}\r\n\r\n`)
      const { transport } = transportFor(push.port)
      expect((await transport.post(request())).status).toBe(status)
      await push.close()
    }
    const seconds = await service(() => 'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 17\r\n\r\n')
    expect((await transportFor(seconds.port).transport.post(request())).retryAfterSeconds).toBe(17)
    await seconds.close()
    const capped = await service(
      () => 'HTTP/1.1 429 Too Many Requests\r\nretry-after: 999999\r\n\r\n',
    )
    expect((await transportFor(capped.port).transport.post(request())).retryAfterSeconds).toBe(3600)
    await capped.close()
    const date = new Date(Date.now() + 90_000).toUTCString()
    const dated = await service(
      () => `HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${date}\r\n\r\n`,
    )
    const wait = (await transportFor(dated.port).transport.post(request())).retryAfterSeconds ?? 0
    expect(wait).toBeGreaterThan(60)
    expect(wait).toBeLessThanOrEqual(91)
    await dated.close()
  })
})

describe('what it will not do', () => {
  test('does not follow a redirect: the second server is never asked', async () => {
    const elsewhere = await service(() => 'HTTP/1.1 201 Created\r\n\r\n')
    const push = await service(
      () =>
        `HTTP/1.1 307 Temporary Redirect\r\nLocation: https://127.0.0.1:${elsewhere.port}/x\r\n\r\n`,
    )
    const response = await transportFor(push.port).transport.post(request())
    expect(response.status).toBe(307)
    expect(elsewhere.requests).toHaveLength(0)
    await push.close()
    await elsewhere.close()
  })

  test('never connects when the name resolves into the private network, whatever else it resolves to', async () => {
    const push = await service(() => 'HTTP/1.1 201 Created\r\n\r\n')
    for (const answers of [
      [{ address: '127.0.0.1', family: 4 as const }],
      [{ address: '169.254.169.254', family: 4 as const }],
      [{ address: '10.0.0.7', family: 4 as const }],
      [{ address: '::1', family: 6 as const }],
      [
        { address: '142.250.80.74', family: 4 as const },
        { address: '192.168.1.1', family: 4 as const },
      ],
    ]) {
      const { transport, dialed } = transportFor(push.port, { answers })
      await expect(transport.post(request())).rejects.toBeInstanceOf(EndpointError)
      expect(dialed).toHaveLength(0)
    }
    expect(push.requests).toHaveLength(0)
    await push.close()
  })

  test('never connects for an endpoint that is not on the list', async () => {
    const push = await service(() => 'HTTP/1.1 201 Created\r\n\r\n')
    const { transport, dialed } = transportFor(push.port)
    for (const endpoint of [
      'http://fcm.googleapis.com/x',
      'https://127.0.0.1/x',
      'https://evil.example/x',
      'https://fcm.googleapis.com:8443/x',
    ]) {
      await expect(transport.post(request({ endpoint }))).rejects.toBeInstanceOf(EndpointError)
    }
    expect(dialed).toHaveLength(0)
    expect(push.requests).toHaveLength(0)
    await push.close()
  })

  test('refuses a header that could start another request, before anything is written', async () => {
    const push = await service(() => 'HTTP/1.1 201 Created\r\n\r\n')
    const { transport } = transportFor(push.port)
    await expect(
      transport.post(request({ headers: { TTL: '1\r\nHost: evil.example' } })),
    ).rejects.toMatchObject({ code: 'bad_request' })
    await expect(transport.post(request({ headers: { 'X Bad': '1' } }))).rejects.toMatchObject({
      code: 'bad_request',
    })
    expect(push.requests).toHaveLength(0)
    await push.close()
  })

  test('a certificate for another name is refused', async () => {
    const other = makeCertificate('evil.example')
    const push = await service(() => 'HTTP/1.1 201 Created\r\n\r\n', other)
    const { transport } = transportFor(push.port, { ca: other.cert })
    // The server's certificate is trusted but is not valid for fcm.googleapis.com.
    await expect(transport.post(request())).rejects.toMatchObject({ code: 'connect_failed' })
    expect(push.requests).toHaveLength(0)
    await push.close()
  })

  test('a certificate nobody trusts is refused', async () => {
    const push = await service(() => 'HTTP/1.1 201 Created\r\n\r\n')
    const { transport } = transportFor(push.port, {
      ca: makeCertificate('fcm.googleapis.com').cert,
    })
    await expect(transport.post(request())).rejects.toMatchObject({ code: 'connect_failed' })
    expect(push.requests).toHaveLength(0)
    await push.close()
  })
})

describe('when the other side misbehaves', () => {
  test('DNS uses the exchange deadline, and a late answer never opens a connection', async () => {
    let answer: (addresses: Resolved[]) => void = () => undefined
    const lookup = new Promise<Resolved[]>((resolve) => {
      answer = resolve
    })
    let dialed = 0
    const transport = createPinnedTransport({
      policy: createEndpointPolicy({ lookup: () => lookup }),
      timeoutMs: 25,
      connector: async () => {
        dialed += 1
        throw new TransportError('connect_failed')
      },
    })
    const pending = transport.post(request()).then(
      () => ({ code: 'delivered' }),
      (error: TransportError) => ({ code: error.code }),
    )
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const stillPending = new Promise<{ code: string }>((resolve) => {
      watchdog = setTimeout(() => resolve({ code: 'DNS still pending' }), 1500)
    })
    try {
      expect(await Promise.race([pending, stillPending])).toEqual({ code: 'timeout' })
    } finally {
      clearTimeout(watchdog)
      answer(PUBLIC)
      await pending
    }
    expect(dialed).toBe(0)
  })

  test('no answer within the time: timeout', async () => {
    const silent = await service(() => null)
    const started = Date.now()
    await expect(
      transportFor(silent.port, { timeoutMs: 300 }).transport.post(request()),
    ).rejects.toMatchObject({
      code: 'timeout',
    })
    expect(Date.now() - started).toBeLessThan(2000)
    await silent.close()
  })

  test('nothing listening: connect_failed', async () => {
    const closed = await service(() => null)
    const port = closed.port
    await closed.close()
    await expect(transportFor(port).transport.post(request())).rejects.toBeInstanceOf(
      TransportError,
    )
  })

  test('garbage, a missing status line, an endless header and a closed connection: bad_response', async () => {
    const cases: Array<string | null> = [
      'not http at all\r\n\r\n',
      'HTTP/2 200\r\n\r\n',
      `HTTP/1.1 200 OK\r\n${'X: y\r\n'.repeat(5000)}`,
      `HTTP/1.1 200 OK\r\n${'X: y\r\n'.repeat(3000)}\r\n`,
    ]
    for (const reply of cases) {
      const push = await service(() => reply)
      await expect(transportFor(push.port).transport.post(request())).rejects.toMatchObject({
        code: 'bad_response',
      })
      await push.close()
    }
    const closing = await service((_, socket) => {
      socket.destroy()
      return null
    })
    await expect(transportFor(closing.port).transport.post(request())).rejects.toBeInstanceOf(
      TransportError,
    )
    await closing.close()
  })

  test('does not wait for the body of the answer', async () => {
    const push = await service(
      () =>
        'HTTP/1.1 201 Created\r\nContent-Length: 1000000\r\n\r\nstart of a body that never finishes',
    )
    const started = Date.now()
    expect((await transportFor(push.port).transport.post(request())).status).toBe(201)
    expect(Date.now() - started).toBeLessThan(1000)
    await push.close()
  })
})
