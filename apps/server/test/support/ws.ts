import { LIMITS } from '@chatapp/contracts'
import { createDispatcher } from '../../src/jobs/dispatcher.ts'
import { createValkey, type Valkey } from '../../src/lib/valkey.ts'
import { createEventBus, type EventBus } from '../../src/realtime/bus.ts'
import { Gateway, type GatewayConfig, type GatewayServices } from '../../src/realtime/gateway.ts'
import { createPresenceStore, type PresenceStore } from '../../src/realtime/presence.ts'
import { connectGatewayToBus } from '../../src/realtime/wiring.ts'
import { type RunningServer, startServer } from '../../src/runtime/server.ts'
import { TEST_ORIGIN } from './deps.ts'
import { testConfig } from './env.ts'
import type { TestApp } from './http.ts'

export const DEFAULT_GATEWAY: GatewayConfig = {
  revalidateMs: LIMITS.wsRevalidateMs,
  heartbeatMs: LIMITS.wsHeartbeatMs,
  pongTimeoutMs: LIMITS.wsPongTimeoutMs,
  maxConnectionsPerUser: LIMITS.wsMaxConnectionsPerUser,
  frameBytes: LIMITS.wsFrameBytes,
  sendBufferBytes: LIMITS.wsSendBufferBytes,
  messageWindowMs: 10_000,
  maxMessagesPerWindow: 200,
}

export type TestServer = {
  port: number
  gateway: Gateway
  bus: EventBus
  presence: PresenceStore
  /** The Valkey prefix of this server's presence data, so a test can inspect it. */
  presencePrefix: string
  valkey: Valkey
  stop: () => Promise<void>
}

/** A real Bun server (random port) with the real gateway, subscribed to a private Pub/Sub channel. */
export async function startTestServer(
  app: TestApp,
  options: {
    gateway?: Partial<GatewayConfig>
    deps?: Partial<ConstructorParameters<typeof Gateway>[0]>
    /** The identity-only gateway of M1a: no topics, no presence. */
    bare?: boolean
    /** Where the gateway reads a person's conversations from, for tests that hold or fail the answers. */
    memberships?: GatewayServices['memberships']
    /** Another Valkey than the shared test one: the isolated instance of the fault suite. */
    valkeyUrl?: string
  } = {},
): Promise<TestServer> {
  const valkeyUrl = options.valkeyUrl ?? testConfig().valkeyUrl
  const publisher: Valkey = await createValkey(valkeyUrl, 'test-ws-pub')
  const subscriber: Valkey = await createValkey(valkeyUrl, 'test-ws-sub')
  const run = Math.random().toString(36).slice(2)
  const channel = `events:test:${run}`
  const presencePrefix = `presence:test:${run}`
  const bus = createEventBus({ publisher, subscriber, channel, log: app.services.log })
  const presence = createPresenceStore(publisher, presencePrefix)
  const gateway = new Gateway(
    { ...app.services.deps, ...(options.deps ?? {}) },
    app.services.log,
    { ...DEFAULT_GATEWAY, ...options.gateway },
    Date.now,
    options.bare ? undefined : { bus, presence, memberships: options.memberships },
  )
  const disconnectBus = await connectGatewayToBus(bus, gateway)
  gateway.start()
  app.services.realtime = gateway
  const server: RunningServer = startServer({
    app: app.app,
    services: app.services,
    gateway,
    hostname: '127.0.0.1',
    port: 0,
  })
  return {
    port: server.port,
    gateway,
    bus,
    presence,
    presencePrefix,
    valkey: publisher,
    stop: async () => {
      gateway.shutdown()
      await disconnectBus().catch(() => undefined)
      await server.stop()
      const keys = await publisher.keys(`${presencePrefix}:*`).catch(() => [])
      if (keys.length > 0) await publisher.del(...keys).catch(() => undefined)
      publisher.disconnect()
      subscriber.disconnect()
    },
  }
}

/**
 * What the worker's dispatcher does every second: turn committed hints into bus events. Runs until nothing is left, so a
 * test can write, flush, and then expect the sockets to have heard.
 */
export async function deliverHints(app: TestApp, server: TestServer): Promise<number> {
  const dispatcher = createDispatcher({
    deps: app.services.deps,
    bus: server.bus,
    emailQueue: { add: async () => undefined } as never,
    log: app.services.log,
  })
  let total = 0
  for (let round = 0; round < 6; round += 1) {
    const claimed = await dispatcher.tick()
    total += claimed
    if (claimed === 0) break
  }
  return total
}

export type TestSocket = {
  ws: WebSocket
  messages: Array<Record<string, unknown>>
  /** Resolves with the close code and reason. */
  closed: Promise<{ code: number; reason: string }>
  opened: Promise<void>
  /** Waits until a message of this type has arrived. */
  next: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>
  /** Waits for a message of this type that satisfies the predicate (from the ones already received on). */
  waitFor: (
    type: string,
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>
  /** Messages of a type received so far. */
  of: (type: string) => Array<Record<string, unknown>>
  send: (message: unknown) => void
}

export function connect(
  port: number,
  options: { origin?: string | null; cookie?: string } = {},
): TestSocket {
  const headers: Record<string, string> = {}
  const origin = options.origin === undefined ? TEST_ORIGIN : options.origin
  if (origin !== null) headers.origin = origin
  if (options.cookie) headers.cookie = options.cookie
  // Bun's WebSocket accepts request headers as a second argument (a non-standard extension).
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers } as never)
  const messages: Array<Record<string, unknown>> = []
  const waiters: Array<{
    type: string
    predicate: (message: Record<string, unknown>) => boolean
    resolve: (m: Record<string, unknown>) => void
  }> = []
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (event) => resolve({ code: event.code, reason: event.reason })
  })
  const opened = new Promise<void>((resolve) => {
    ws.onopen = () => resolve()
  })
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>
    messages.push(message)
    for (const waiter of [...waiters]) {
      if (waiter.type === message.type && waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      }
    }
  }
  const waitFor = (
    type: string,
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs = 3_000,
  ) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const existing = messages.find((m) => m.type === type && predicate(m))
      if (existing) return resolve(existing)
      const timer = setTimeout(
        () => reject(new Error(`no matching ${type} message within ${timeoutMs} ms`)),
        timeoutMs,
      )
      waiters.push({
        type,
        predicate,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  return {
    ws,
    messages,
    closed,
    opened,
    next: (type, timeoutMs) => waitFor(type, () => true, timeoutMs),
    waitFor,
    of: (type) => messages.filter((m) => m.type === type),
    send: (message) => ws.send(JSON.stringify(message)),
  }
}

export const cookieHeader = (jar: Map<string, string>): string =>
  [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
