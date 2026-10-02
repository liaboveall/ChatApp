import { describe, expect, test } from 'bun:test'
import { WS_CLOSE } from '@chatapp/contracts'
import { silentLogger } from '../lib/logger.ts'
import { Gateway, type GatewayConfig, type Socket } from './gateway.ts'

class FakeSocket implements Socket {
  sent: string[] = []
  closedWith: { code: number; reason?: string } | undefined
  pings = 0
  buffered = 0
  send(text: string) {
    this.sent.push(text)
  }
  close(code: number, reason?: string) {
    this.closedWith = { code, reason }
  }
  ping() {
    this.pings += 1
  }
  bufferedAmount() {
    return this.buffered
  }
}

const config: GatewayConfig = {
  revalidateMs: 5_000,
  heartbeatMs: 25_000,
  pongTimeoutMs: 60_000,
  maxConnectionsPerUser: 2,
  frameBytes: 1024,
  sendBufferBytes: 4096,
  messageWindowMs: 10_000,
  maxMessagesPerWindow: 3,
}

function setup(overrides: Partial<GatewayConfig> = {}) {
  let now = 1_000_000
  let counter = 0
  const gateway = new Gateway(
    {
      db: undefined as never,
      clock: { now: () => new Date(now) },
      config: { auth: { restoreEpoch: 'e1' } } as never,
      newId: () => `00000000-0000-7000-8000-${String(++counter).padStart(12, '0')}`,
    },
    silentLogger,
    { ...config, ...overrides },
    () => now,
  )
  const identity = (userId = 'u1') => ({
    sessionId: `s-${++counter}`,
    userId,
    originId: 'o',
    authEpoch: 0,
    restoreEpoch: 'e1',
  })
  const advance = (ms: number) => {
    now += ms
  }
  return { gateway, identity, advance }
}

describe('Gateway (unit, fake sockets)', () => {
  test('accept sends hello with the identity and server time', () => {
    const { gateway, identity } = setup()
    const socket = new FakeSocket()
    const connection = gateway.accept(socket, identity('u1'))
    const hello = JSON.parse(socket.sent[0] ?? '{}')
    expect(hello).toMatchObject({
      v: 1,
      type: 'hello',
      data: { userId: 'u1', heartbeatMs: 25_000, connectionId: connection.id },
    })
    expect(gateway.connectionCount).toBe(1)
  })

  test('heartbeat: pings while alive, 4408 after 60 s of silence, activity resets the clock', () => {
    const { gateway, identity, advance } = setup()
    const quiet = new FakeSocket()
    const chatty = new FakeSocket()
    gateway.accept(quiet, identity('u1'))
    const active = gateway.accept(chatty, identity('u2'))
    advance(25_000)
    gateway.heartbeatTick()
    expect([quiet.pings, chatty.pings]).toEqual([1, 1])
    advance(25_000)
    gateway.pong(active)
    advance(11_000)
    gateway.heartbeatTick()
    expect(quiet.closedWith?.code).toBe(WS_CLOSE.HEARTBEAT_TIMEOUT)
    expect(chatty.closedWith).toBeUndefined()
    expect(gateway.connectionCount).toBe(1)
  })

  test('per-user cap evicts the oldest with 4409 and leaves other users alone', () => {
    const { gateway, identity } = setup({ maxConnectionsPerUser: 2 })
    const [a, b, c, other] = [
      new FakeSocket(),
      new FakeSocket(),
      new FakeSocket(),
      new FakeSocket(),
    ]
    gateway.accept(a, identity('u1'))
    gateway.accept(other, identity('u2'))
    gateway.accept(b, identity('u1'))
    gateway.accept(c, identity('u1'))
    expect(a.closedWith?.code).toBe(WS_CLOSE.TOO_MANY_CONNECTIONS)
    expect(b.closedWith).toBeUndefined()
    expect(other.closedWith).toBeUndefined()
    expect(gateway.connectionCount).toBe(3)
  })

  test('message rate window: the 4th message in a window closes with 4429, a new window resets', () => {
    const { gateway, identity, advance } = setup()
    const socket = new FakeSocket()
    const connection = gateway.accept(socket, identity())
    const ping = JSON.stringify({ v: 1, type: 'ping', data: {} })
    for (let i = 0; i < 3; i += 1) gateway.receive(connection, ping)
    expect(socket.closedWith).toBeUndefined()
    advance(11_000)
    for (let i = 0; i < 3; i += 1) gateway.receive(connection, ping)
    expect(socket.closedWith).toBeUndefined()
    gateway.receive(connection, ping)
    expect(socket.closedWith?.code).toBe(WS_CLOSE.TOO_MANY_MESSAGES)
  })

  test('frames: binary 1003, oversized 1009 (measured in bytes, not characters)', () => {
    const { gateway, identity } = setup({ maxMessagesPerWindow: 100 })
    const binary = new FakeSocket()
    gateway.receive(gateway.accept(binary, identity('u1')), new Uint8Array([1]))
    expect(binary.closedWith?.code).toBe(1003)
    const big = new FakeSocket()
    // 600 CJK characters are 1800 bytes: over the 1024-byte limit although under it in characters.
    gateway.receive(gateway.accept(big, identity('u2')), '中'.repeat(600))
    expect(big.closedWith?.code).toBe(1009)
  })

  test('a slow client is disconnected with 1013 instead of buffering without bound', () => {
    const { gateway, identity } = setup()
    const socket = new FakeSocket()
    const connection = gateway.accept(socket, identity())
    socket.buffered = 10_000
    gateway.receive(connection, JSON.stringify({ v: 1, type: 'ping', data: {} }))
    expect(socket.closedWith?.code).toBe(WS_CLOSE.TRY_AGAIN_LATER)
  })

  test('shutdown closes everything with 1012; closed connections are forgotten', () => {
    const { gateway, identity } = setup()
    const sockets = [new FakeSocket(), new FakeSocket()]
    for (const [i, socket] of sockets.entries()) gateway.accept(socket, identity(`u${i}`))
    gateway.shutdown()
    expect(sockets.every((s) => s.closedWith?.code === WS_CLOSE.SERVER_RESTART)).toBe(true)
    expect(gateway.connectionCount).toBe(0)
  })
})
