import { LIMITS } from '@chatapp/contracts'
import { createValkey, type Valkey } from '../../src/lib/valkey.ts'
import { createEventBus, type EventBus } from '../../src/realtime/bus.ts'
import { Gateway, type GatewayConfig } from '../../src/realtime/gateway.ts'
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
  stop: () => Promise<void>
}

/** A real Bun server (random port) with the real gateway, subscribed to a private Pub/Sub channel. */
export async function startTestServer(
  app: TestApp,
  options: {
    gateway?: Partial<GatewayConfig>
    deps?: Partial<ConstructorParameters<typeof Gateway>[0]>
  } = {},
): Promise<TestServer> {
  const config = testConfig()
  const publisher: Valkey = await createValkey(config.valkeyUrl, 'test-ws-pub')
  const subscriber: Valkey = await createValkey(config.valkeyUrl, 'test-ws-sub')
  const channel = `events:test:${Math.random().toString(36).slice(2)}`
  const bus = createEventBus({ publisher, subscriber, channel, log: app.services.log })
  const gateway = new Gateway({ ...app.services.deps, ...(options.deps ?? {}) }, app.services.log, {
    ...DEFAULT_GATEWAY,
    ...options.gateway,
  })
  await bus.subscribe((event) => gateway.handleEvent(event))
  gateway.start()
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
    stop: async () => {
      gateway.shutdown()
      await server.stop()
      publisher.disconnect()
      subscriber.disconnect()
    },
  }
}

export type TestSocket = {
  ws: WebSocket
  messages: Array<Record<string, unknown>>
  /** Resolves with the close code and reason. */
  closed: Promise<{ code: number; reason: string }>
  opened: Promise<void>
  /** Waits until a message of this type has arrived. */
  next: (type: string, timeoutMs?: number) => Promise<Record<string, unknown>>
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
  const waiters: Array<{ type: string; resolve: (m: Record<string, unknown>) => void }> = []
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
      if (waiter.type === message.type) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      }
    }
  }
  const next = (type: string, timeoutMs = 3_000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const existing = messages.find((m) => m.type === type)
      if (existing) return resolve(existing)
      const timer = setTimeout(
        () => reject(new Error(`no ${type} message within ${timeoutMs} ms`)),
        timeoutMs,
      )
      waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  return { ws, messages, closed, opened, next }
}

export const cookieHeader = (jar: Map<string, string>): string =>
  [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
