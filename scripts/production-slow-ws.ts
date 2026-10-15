/** Bounded RFC 6455 clients whose TLS reads really pause. No request headers, frames or cookies enter receipts. */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { connect, type TLSSocket } from 'node:tls'
import {
  type LoadFixture,
  loadFixtureSchema,
  wsServerMessageSchema,
} from '../packages/contracts/src/index.ts'

const MAX_FRAME = 64 * 1024
export function clientFrame(opcode: number, payload: Uint8Array) {
  if (![1, 8, 10].includes(opcode) || payload.length > 125)
    throw new Error('bounded control frame required')
  const mask = randomBytes(4),
    out = Buffer.alloc(payload.length + 6)
  out[0] = 0x80 | opcode
  out[1] = 0x80 | payload.length
  mask.copy(out, 2)
  for (let i = 0; i < payload.length; i++) out[i + 6] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0)
  return out
}
export function serverFrame(
  buffer: Buffer,
): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) return null
  const first = buffer[0] ?? 0,
    second = buffer[1] ?? 0
  if (!(first & 0x80) || first & 0x70 || second & 0x80) throw new Error('unexpected server framing')
  const opcode = first & 15
  if (![1, 8, 9, 10].includes(opcode)) throw new Error('unexpected server opcode')
  let bytes = second & 127,
    offset = 2
  if (bytes === 126) {
    if (buffer.length < 4) return null
    bytes = buffer.readUInt16BE(2)
    offset = 4
    if (bytes < 126) throw new Error('noncanonical frame length')
  } else if (bytes === 127) {
    if (buffer.length < 10) return null
    const length = buffer.readBigUInt64BE(2)
    if (length > BigInt(MAX_FRAME) || length <= 65535n) throw new Error('frame limit exceeded')
    bytes = Number(length)
    offset = 10
  }
  if (bytes > MAX_FRAME || (opcode >= 8 && bytes > 125)) throw new Error('frame limit exceeded')
  if (buffer.length < offset + bytes) return null
  return { opcode, payload: buffer.subarray(offset, offset + bytes), consumed: offset + bytes }
}
export async function runSlowWebSockets(
  fixture: LoadFixture,
  options: {
    seconds: number
    count: number
    ca?: string
    connectHost?: string
    connectPort?: number
    sourceIps?: string[]
    signal?: AbortSignal
  },
) {
  if (
    !Number.isInteger(options.seconds) ||
    options.seconds < 6 ||
    options.seconds > 3600 ||
    !Number.isInteger(options.count) ||
    options.count < 1 ||
    options.count > 50
  )
    throw new Error('bounded slow-client plan required')
  const origin = new URL(fixture.origin)
  if (origin.protocol !== 'https:' || origin.origin !== fixture.origin)
    throw new Error('HTTPS origin required')
  const totals = {
    connections: options.count,
    authorizedHello: 0,
    pauses: 0,
    messages: 0,
    unexpected: 0,
    maxBufferedBytes: 0,
  }
  let closed = 0
  await Promise.all(
    Array.from({ length: options.count }, async (_, index) => {
      const user = fixture.users[index % Math.min(fixture.users.length, 200)]
      if (!user) throw new Error('authenticated fixture missing')
      const key = randomBytes(16).toString('base64')
      const expectedAccept = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      let buffer: Buffer = Buffer.alloc(0),
        upgraded = false,
        greeted = false,
        stopping = false,
        failed = false
      let ping: ReturnType<typeof setInterval> | undefined,
        pause: ReturnType<typeof setInterval> | undefined
      let resume: ReturnType<typeof setTimeout> | undefined,
        finish: ReturnType<typeof setTimeout> | undefined
      await new Promise<void>((resolve) => {
        let socket: TLSSocket
        const stop = () => {
          if (stopping) return
          stopping = true
          clearInterval(ping)
          clearInterval(pause)
          clearTimeout(resume)
          clearTimeout(finish)
          options.signal?.removeEventListener('abort', stop)
          socket.destroy()
        }
        const fail = () => {
          if (!failed) {
            failed = true
            totals.unexpected++
          }
          stop()
        }
        socket = connect({
          host: options.connectHost ?? origin.hostname,
          port: options.connectPort ?? Number(origin.port || 443),
          servername: origin.hostname,
          rejectUnauthorized: true,
          ...(options.ca ? { ca: options.ca } : {}),
          ...(options.sourceIps?.length
            ? { localAddress: options.sourceIps[index % options.sourceIps.length] }
            : {}),
          ALPNProtocols: ['http/1.1'],
        })
        socket.setTimeout(10_000)
        socket.once('timeout', fail)
        socket.on('error', fail)
        socket.once('secureConnect', () => {
          socket.write(
            `GET /ws HTTP/1.1\r\nHost: ${origin.host}\r\nOrigin: ${fixture.origin}\r\nCookie: ${user.cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          )
        })
        socket.on('data', (chunk: Buffer) => {
          try {
            if (chunk.length + buffer.length > 128 * 1024)
              throw new Error('bounded receive buffer exceeded')
            buffer = Buffer.concat([buffer, chunk])
            totals.maxBufferedBytes = Math.max(totals.maxBufferedBytes, buffer.length)
            if (!upgraded) {
              const end = buffer.indexOf('\r\n\r\n')
              if (end < 0) {
                if (buffer.length > 16 * 1024) fail()
                return
              }
              if (end > 16 * 1024) throw new Error('header limit exceeded')
              const lines = buffer.subarray(0, end).toString('utf8').split('\r\n'),
                status = lines.shift()
              const headers = new Map<string, string>()
              for (const line of lines) {
                const colon = line.indexOf(':')
                if (colon < 1) throw new Error('invalid upgrade header')
                const name = line.slice(0, colon).toLowerCase(),
                  value = line.slice(colon + 1).trim()
                if (headers.has(name)) throw new Error('duplicate upgrade header')
                headers.set(name, value)
              }
              if (
                status !== 'HTTP/1.1 101 Switching Protocols' ||
                headers.get('sec-websocket-accept') !== expectedAccept ||
                headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
                !headers
                  .get('connection')
                  ?.toLowerCase()
                  .split(/\s*,\s*/)
                  .includes('upgrade')
              )
                throw new Error('upgrade rejected')
              upgraded = true
              buffer = buffer.subarray(end + 4)
            }
            for (;;) {
              const frame = serverFrame(buffer)
              if (!frame) break
              buffer = buffer.subarray(frame.consumed)
              if (frame.opcode === 8) {
                if (!stopping) fail()
                break
              }
              if (frame.opcode === 9) {
                socket.write(clientFrame(10, frame.payload))
                continue
              }
              if (frame.opcode !== 1) continue
              const message = wsServerMessageSchema.parse(
                JSON.parse(frame.payload.toString('utf8')),
              )
              totals.messages++
              if (message.type === 'error') throw new Error('application frame rejected')
              if (message.type === 'hello') {
                if (greeted || message.data.userId !== user.userId)
                  throw new Error('session identity mismatch')
                greeted = true
                totals.authorizedHello++
                socket.setTimeout(0)
                const pauseReading = () => {
                  socket.pause()
                  totals.pauses++
                  resume = setTimeout(() => socket.resume(), 5000)
                }
                pauseReading()
                pause = setInterval(pauseReading, 5200)
                ping = setInterval(
                  () =>
                    socket.write(
                      clientFrame(1, Buffer.from(JSON.stringify({ v: 1, type: 'ping', data: {} }))),
                    ),
                  20_000,
                )
                finish = setTimeout(stop, options.seconds * 1000)
              }
            }
          } catch {
            fail()
          }
        })
        socket.once('close', () => {
          if (!stopping || !greeted) {
            if (!failed) totals.unexpected++
          }
          stop()
          closed++
          resolve()
        })
        options.signal?.addEventListener('abort', stop, { once: true })
        if (options.signal?.aborted) stop()
      })
    }),
  )
  return {
    format: 1,
    ...totals,
    closed,
    sourceHash: fixture.sourceHash,
    healthy:
      totals.authorizedHello === options.count &&
      totals.unexpected === 0 &&
      totals.pauses >= options.count &&
      !options.signal?.aborted,
    scope:
      'actual five-second TLS read pauses; payload contents and slow-client latency do not enter fast delivery percentiles',
  }
}

if (import.meta.main) {
  try {
    const [file, seconds, count, output, caFile, connectHost, connectPort] = process.argv.slice(2)
    if (!file || !output) throw new Error('private fixture and new result required')
    const info = await lstat(file)
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024 * 1024)
      throw new Error('private bounded fixture required')
    const fixture = loadFixtureSchema.parse(JSON.parse(await readFile(file, 'utf8')))
    const receipt = await runSlowWebSockets(fixture, {
      seconds: Number(seconds),
      count: Number(count),
      ...(caFile ? { ca: await readFile(caFile, 'utf8') } : {}),
      ...(connectHost ? { connectHost } : {}),
      ...(connectPort ? { connectPort: Number(connectPort) } : {}),
    })
    await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(
      JSON.stringify({
        healthy: receipt.healthy,
        connections: receipt.connections,
        pauses: receipt.pauses,
      }),
    )
    if (!receipt.healthy) process.exitCode = 1
  } catch {
    console.error('slow-client check rejected or failed')
    process.exitCode = 1
  }
}
