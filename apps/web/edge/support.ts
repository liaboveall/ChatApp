/**
 * Helpers for the edge suite: raw connections to the gateway (to say what an HTTP client library would refuse to), the
 * gateway's access log and the API's log, and the suite's own budget. Everything reaches the API from the gateway's
 * address, so the per-address limits of registration and sign-in are shared by the whole suite: it spends few of them
 * and stops at the first 429 (D-147).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { connect, type TLSSocket } from 'node:tls'
import { fileURLToPath } from 'node:url'

export const HOST = 'chat.localhost'
export const PORT = 8443

/** The result of one request written by hand to the gateway. */
export type RawAnswer = {
  /** What came back, all of it (empty when the gateway closed the connection without a word). */
  text: string
  status: number | null
  headers: Record<string, string[]>
  closed: boolean
  elapsedMs: number
}

function parse(text: string): Pick<RawAnswer, 'status' | 'headers'> {
  const head = text.split('\r\n\r\n')[0] ?? ''
  const lines = head.split('\r\n')
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? Number.NaN)
  const headers: Record<string, string[]> = {}
  for (const line of lines.slice(1)) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const name = line.slice(0, at).trim().toLowerCase()
    const list = headers[name] ?? []
    list.push(line.slice(at + 1).trim())
    headers[name] = list
  }
  return { status: Number.isNaN(status) ? null : status, headers }
}

/**
 * Opens a TLS connection, writes `chunks` (each after `pauseMs`), and collects the answer until the gateway closes the
 * connection or `waitMs` has passed. HTTP/1.1 with `Connection: close` unless the caller wrote its own.
 */
export async function raw(
  chunks: string[],
  options: { pauseMs?: number; waitMs?: number } = {},
): Promise<RawAnswer> {
  const { pauseMs = 0, waitMs = 10_000 } = options
  const started = Date.now()
  const socket: TLSSocket = connect({
    host: '127.0.0.1',
    port: PORT,
    servername: HOST,
    rejectUnauthorized: false,
  })
  const received: Buffer[] = []
  let closed = false
  socket.on('data', (data) => received.push(data))
  socket.on('error', () => undefined)
  const done = new Promise<void>((resolve) => {
    socket.on('close', () => {
      closed = true
      resolve()
    })
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => resolve())
    socket.once('error', reject)
  })
  for (const chunk of chunks) {
    socket.write(chunk)
    if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
  }
  await Promise.race([done, new Promise((resolve) => setTimeout(resolve, waitMs))])
  socket.destroy()
  const text = Buffer.concat(received).toString('latin1')
  return { text, closed, elapsedMs: Date.now() - started, ...parse(text) }
}

/** The request line and headers of a plain request to the gateway. */
export const request = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = '',
): string =>
  [
    `${method} ${path} HTTP/1.1`,
    `Host: ${HOST}:${PORT}`,
    'Connection: close',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    ...(body === '' ? [] : [`Content-Length: ${Buffer.byteLength(body)}`]),
    '',
    body,
  ].join('\r\n')

const CONTAINER = 'chatapp-edge-nginx-1'

/** The gateway's access log. */
export function gatewayLog(): string {
  return execFileSync('docker', ['exec', CONTAINER, 'cat', '/var/log/nginx/chatapp-access.log'], {
    encoding: 'utf8',
  })
}

/** What the API process wrote (the stack is started with a log file for this suite). */
export function apiLog(): string {
  const path = fileURLToPath(new URL('../../../.test-runs/edge/api.log', import.meta.url))
  return readFileSync(path, 'utf8')
}

/** A value that cannot occur by accident, to look for in logs. */
export const sentinel = (label: string): string =>
  `SENTINEL-${label}-${crypto.randomUUID().replaceAll('-', '')}`
