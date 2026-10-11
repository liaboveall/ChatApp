/**
 * The one HTTPS request a push is (SEC-23, D-065, AT-11). `fetch` resolves the name itself, so it could connect somewhere
 * other than the address that was checked; this transport therefore makes the connection by hand:
 *
 *   1. the endpoint passes the allow-list (`checkEndpoint`);
 *   2. its name is resolved and *every* answer must be a public address (`policy.resolve`);
 *   3. TLS is opened to one of those addresses, with the host name as SNI and as the name the certificate must match;
 *   4. one POST is written and only the status line and headers are read; nothing is followed (a redirect is an error),
 *      and the whole exchange has 5 seconds.
 *
 * The HTTP/1.1 exchange is written out here instead of through `node:https` on purpose: Bun implements that module on top
 * of its own `fetch`, which ignores a pinned address, and a quietly ignored `lookup` would be exactly the hole this closes.
 */
import { type TLSSocket, connect as tlsConnect } from 'node:tls'
import { EndpointError, type EndpointPolicy, type Resolved } from './push-endpoints.ts'

export type PushRequest = {
  endpoint: string
  headers: Record<string, string>
  body: Uint8Array
}

export type PushResponse = { status: number; retryAfterSeconds: number | null }

export type TransportFailure = 'timeout' | 'connect_failed' | 'bad_response' | 'bad_request'

/** The request could not be completed; the caller treats it as "outcome unknown" and retries later. */
export class TransportError extends Error {
  constructor(readonly code: TransportFailure) {
    super(code)
    this.name = 'TransportError'
  }
}

export interface PushTransport {
  /** Rejects with `EndpointError` when the endpoint may not be used, with `TransportError` when it could not be reached. */
  post(request: PushRequest): Promise<PushResponse>
}

/** Opens the TLS connection to one already-checked address. Replaced in tests (to reach a local server). */
export type Connector = (target: {
  address: string
  servername: string
  signal: AbortSignal
}) => Promise<TLSSocket>

const MAX_HEAD_BYTES = 16 * 1024
const MAX_RETRY_AFTER_SECONDS = 3600
const HEADER_NAME = /^[A-Za-z0-9-]+$/
const HEADER_VALUE = /^[\x20-\x7e]*$/

/**
 * Production dials the checked address on port 443. The options exist so that tests can dial a local server instead (and
 * trust its certificate) while the rest, the name used for the handshake and the certificate check, stays the same.
 */
export function createConnector(
  options: {
    port?: number
    /** Which address to actually dial for a checked one (tests only). */
    dial?: (address: string) => string
    ca?: string | Buffer
  } = {},
): Connector {
  return ({ address, servername, signal }) =>
    new Promise((resolve, reject) => {
      // `host` is the checked address, `servername` the name: the handshake and the certificate check use the name, the
      // connection goes to the address.
      const socket = tlsConnect({
        host: options.dial ? options.dial(address) : address,
        port: options.port ?? 443,
        servername,
        minVersion: 'TLSv1.2',
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: true,
        ...(options.ca ? { ca: options.ca } : {}),
      })
      const abort = (): void => {
        socket.destroy()
        reject(new TransportError('timeout'))
      }
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      socket.once('secureConnect', () => {
        signal.removeEventListener('abort', abort)
        resolve(socket)
      })
      socket.once('error', () => {
        signal.removeEventListener('abort', abort)
        reject(new TransportError('connect_failed'))
      })
    })
}

export const realConnector: Connector = createConnector()

/** DNS cannot be cancelled by every resolver, but a late answer must never keep this request alive or start a dial. */
function withinDeadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new TransportError('timeout'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (/^\d{1,9}$/.test(trimmed)) return Math.min(Number(trimmed), MAX_RETRY_AFTER_SECONDS)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return null
  return Math.min(Math.max(0, Math.ceil((date - nowMs) / 1000)), MAX_RETRY_AFTER_SECONDS)
}

function requestHead(url: URL, headers: Record<string, string>, length: number): string {
  const lines = [`POST ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`]
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name) || !HEADER_VALUE.test(value))
      throw new TransportError('bad_request')
    lines.push(`${name}: ${value}`)
  }
  lines.push(`Content-Length: ${length}`, 'Connection: close', '', '')
  return lines.join('\r\n')
}

/** Writes the request and reads the status line and headers of the answer; the body of the answer is never read. */
function exchange(
  socket: TLSSocket,
  head: string,
  body: Uint8Array,
  signal: AbortSignal,
  nowMs: () => number,
): Promise<PushResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const done = (outcome: () => void): void => {
      signal.removeEventListener('abort', onAbort)
      socket.destroy()
      outcome()
    }
    const onAbort = (): void => done(() => reject(new TransportError('timeout')))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    socket.on('error', () => done(() => reject(new TransportError('connect_failed'))))
    socket.on('close', () => done(() => reject(new TransportError('bad_response'))))
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      const text = Buffer.concat(chunks).toString('latin1')
      const end = text.indexOf('\r\n\r\n')
      if (end === -1) {
        if (size > MAX_HEAD_BYTES) done(() => reject(new TransportError('bad_response')))
        return
      }
      if (end + 4 > MAX_HEAD_BYTES) return done(() => reject(new TransportError('bad_response')))
      const lines = text.slice(0, end).split('\r\n')
      const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0] ?? '')
      if (!status) return done(() => reject(new TransportError('bad_response')))
      let retryAfter: string | undefined
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':')
        if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === 'retry-after') {
          retryAfter = line.slice(colon + 1)
        }
      }
      const code = Number(status[1])
      done(() => resolve({ status: code, retryAfterSeconds: parseRetryAfter(retryAfter, nowMs()) }))
    })
    socket.write(head)
    socket.write(body)
  })
}

export function createPinnedTransport(options: {
  policy: EndpointPolicy
  timeoutMs?: number
  connector?: Connector
  now?: () => number
}): PushTransport {
  const timeoutMs = options.timeoutMs ?? 5000
  const connector = options.connector ?? realConnector
  const now = options.now ?? Date.now
  return {
    async post(request) {
      const verdict = options.policy.check(request.endpoint)
      if (!verdict.ok) throw new EndpointError(verdict.reason)
      const head = requestHead(verdict.url, request.headers, request.body.length)
      const signal = AbortSignal.timeout(timeoutMs)
      const addresses: Resolved[] = await withinDeadline(
        options.policy.resolve(verdict.hostname),
        signal,
      )
      let socket: TLSSocket | undefined
      // Try the checked addresses in the resolver's order until one accepts the connection.
      for (const target of addresses) {
        if (signal.aborted) throw new TransportError('timeout')
        try {
          socket = await connector({
            address: target.address,
            servername: verdict.hostname,
            signal,
          })
          break
        } catch (error) {
          if (error instanceof TransportError && error.code === 'timeout') throw error
        }
      }
      if (!socket) throw new TransportError('connect_failed')
      return await exchange(socket, head, request.body, signal, now)
    },
  }
}
