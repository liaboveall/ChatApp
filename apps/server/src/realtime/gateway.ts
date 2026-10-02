/**
 * WebSocket gateway skeleton (docs/03 sections 5.8 and 6, docs/05 section 4, SEC-03, SEC-24).
 *
 * A connection belongs to ONE login session. It stays open only while that session, its account, its auth epoch and its
 * device origin keep checking out: revocation hints (Pub/Sub) re-check at once, and every `revalidateMs` (5 s) the
 * gateway re-checks all connections against Postgres. If the check itself fails the gateway fails closed (1013). The
 * gateway only holds an abstract `Socket`; the Bun binding lives in api.ts. M1a speaks hello/ping/pong/error only.
 */
import {
  WS_CLOSE,
  WS_PROTOCOL_VERSION,
  type WsServerMessage,
  wsClientMessageSchema,
} from '@chatapp/contracts'
import type { Deps } from '../domain/deps.ts'
import { type SessionRef, validateSessions } from '../domain/sessions.ts'
import type { Logger } from '../lib/logger.ts'
import type { BusEvent } from './events.ts'

export interface Socket {
  send(text: string): void
  close(code: number, reason?: string): void
  /** Protocol-level ping frame. */
  ping(): void
  /** Bytes queued for the client but not yet written. */
  bufferedAmount(): number
}

export type GatewayConfig = {
  revalidateMs: number
  heartbeatMs: number
  pongTimeoutMs: number
  maxConnectionsPerUser: number
  frameBytes: number
  sendBufferBytes: number
  messageWindowMs: number
  maxMessagesPerWindow: number
}

export type ConnectionIdentity = {
  sessionId: string
  userId: string
  originId: string
  authEpoch: number
  restoreEpoch: string
}

export type Connection = {
  readonly id: string
  readonly socket: Socket
  readonly identity: ConnectionIdentity
  lastActivity: number
  windowStart: number
  windowCount: number
  closed: boolean
}

export class Gateway {
  readonly #deps: Pick<Deps, 'db' | 'clock' | 'config' | 'newId'>
  readonly #log: Logger
  readonly #config: GatewayConfig
  readonly #now: () => number
  readonly #byId = new Map<string, Connection>()
  readonly #byUser = new Map<string, Set<string>>()
  #timers: ReturnType<typeof setInterval>[] = []
  #checking: Promise<void> | undefined

  constructor(
    deps: Pick<Deps, 'db' | 'clock' | 'config' | 'newId'>,
    log: Logger,
    config: GatewayConfig,
    now: () => number = Date.now,
  ) {
    this.#deps = deps
    this.#log = log
    this.#config = config
    this.#now = now
  }

  get connectionCount(): number {
    return this.#byId.size
  }

  start(): void {
    this.#timers.push(setInterval(() => void this.revalidateAll(), this.#config.revalidateMs))
    this.#timers.push(setInterval(() => this.heartbeatTick(), this.#config.heartbeatMs))
  }

  stop(): void {
    for (const timer of this.#timers) clearInterval(timer)
    this.#timers = []
  }

  /** Closes everything for a restart (1012: clients reconnect with backoff). */
  shutdown(): void {
    this.stop()
    for (const connection of [...this.#byId.values()])
      this.#close(connection, WS_CLOSE.SERVER_RESTART, 'restart')
  }

  /** Registers an authenticated socket, enforces the per-user cap (oldest goes, 4409) and greets with `hello`. */
  accept(socket: Socket, identity: ConnectionIdentity): Connection {
    const now = this.#now()
    const connection: Connection = {
      id: this.#deps.newId(),
      socket,
      identity,
      lastActivity: now,
      windowStart: now,
      windowCount: 0,
      closed: false,
    }
    this.#byId.set(connection.id, connection)
    const mine = this.#byUser.get(identity.userId) ?? new Set<string>()
    this.#byUser.set(identity.userId, mine)
    mine.add(connection.id)
    while (mine.size > this.#config.maxConnectionsPerUser) {
      const oldest = mine.values().next().value
      const victim = oldest === undefined ? undefined : this.#byId.get(oldest)
      if (!victim || victim === connection) break
      this.#close(victim, WS_CLOSE.TOO_MANY_CONNECTIONS, 'too many connections')
    }
    this.#log.info('ws.connected', { connectionId: connection.id, userId: identity.userId })
    this.#send(connection, {
      v: WS_PROTOCOL_VERSION,
      type: 'hello',
      data: {
        connectionId: connection.id,
        userId: identity.userId,
        authEpoch: identity.authEpoch,
        restoreEpoch: identity.restoreEpoch,
        serverTime: this.#deps.clock.now().toISOString(),
        heartbeatMs: this.#config.heartbeatMs,
      },
    })
    return connection
  }

  /** One inbound frame: text JSON only, bounded in size and rate, validated against the contract. */
  receive(connection: Connection, frame: string | Uint8Array): void {
    if (connection.closed) return
    connection.lastActivity = this.#now()
    if (typeof frame !== 'string') {
      this.#close(connection, 1003, 'binary frames are not supported')
      return
    }
    if (new TextEncoder().encode(frame).byteLength > this.#config.frameBytes) {
      this.#close(connection, 1009, 'frame too large')
      return
    }
    const now = this.#now()
    if (now - connection.windowStart > this.#config.messageWindowMs) {
      connection.windowStart = now
      connection.windowCount = 0
    }
    connection.windowCount += 1
    if (connection.windowCount > this.#config.maxMessagesPerWindow) {
      this.#close(connection, WS_CLOSE.TOO_MANY_MESSAGES, 'too many messages')
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(frame)
    } catch {
      this.#error(connection, 'invalid_message', 'Message is not valid JSON')
      return
    }
    const message = wsClientMessageSchema.safeParse(parsed)
    if (!message.success) {
      this.#error(connection, 'unknown_message', 'Unknown or malformed message')
      return
    }
    if (message.data.type === 'ping') {
      this.#send(connection, {
        v: WS_PROTOCOL_VERSION,
        type: 'pong',
        data: { serverTime: this.#deps.clock.now().toISOString() },
      })
    }
  }

  pong(connection: Connection): void {
    connection.lastActivity = this.#now()
  }

  closed(connection: Connection, code: number): void {
    if (connection.closed && !this.#byId.has(connection.id)) return
    this.#unregister(connection)
    this.#log.info('ws.closed', {
      connectionId: connection.id,
      userId: connection.identity.userId,
      closeCode: code,
    })
  }

  /** Event from the bus: a revocation for this user re-checks its connections immediately. */
  handleEvent(event: BusEvent): void {
    if (event.type === 'auth.revoked') void this.revalidateUser(event.userId)
  }

  async revalidateUser(userId: string): Promise<void> {
    const ids = this.#byUser.get(userId)
    if (!ids) return
    await this.#revalidate(
      [...ids].map((id) => this.#byId.get(id)).filter((c): c is Connection => c !== undefined),
    )
  }

  /** Periodic backstop (5 s): also catches revocations whose hint was lost. Overlapping runs are skipped. */
  async revalidateAll(): Promise<void> {
    if (this.#checking) return
    this.#checking = this.#revalidate([...this.#byId.values()]).finally(() => {
      this.#checking = undefined
    })
    await this.#checking
  }

  async #revalidate(connections: Connection[]): Promise<void> {
    const open = connections.filter((connection) => !connection.closed)
    if (open.length === 0) return
    const refs: SessionRef[] = open.map((connection) => ({
      sessionId: connection.identity.sessionId,
      userId: connection.identity.userId,
      authEpoch: connection.identity.authEpoch,
      originId: connection.identity.originId,
    }))
    let valid: Set<string>
    try {
      valid = await validateSessions(this.#deps, refs)
    } catch {
      // Cannot vouch for anyone: stop serving and let clients reconnect with backoff once the database is back.
      this.#log.warn('ws.revalidation_failed', { count: open.length })
      for (const connection of open)
        this.#close(connection, WS_CLOSE.TRY_AGAIN_LATER, 'dependency unavailable')
      return
    }
    for (const connection of open) {
      if (!valid.has(connection.identity.sessionId)) {
        this.#close(connection, WS_CLOSE.UNAUTHENTICATED, 'session ended')
      }
    }
  }

  /** 25 s: send a protocol ping; 60 s without any sign of life: 4408. */
  heartbeatTick(): void {
    const now = this.#now()
    for (const connection of [...this.#byId.values()]) {
      if (now - connection.lastActivity > this.#config.pongTimeoutMs) {
        this.#close(connection, WS_CLOSE.HEARTBEAT_TIMEOUT, 'heartbeat timeout')
      } else {
        try {
          connection.socket.ping()
        } catch {
          this.#close(connection, WS_CLOSE.TRY_AGAIN_LATER, 'ping failed')
        }
      }
    }
  }

  #send(connection: Connection, message: WsServerMessage): void {
    if (connection.closed) return
    if (connection.socket.bufferedAmount() > this.#config.sendBufferBytes) {
      // A slow client is disconnected instead of buffering without bound; it resynchronizes when it reconnects.
      this.#close(connection, WS_CLOSE.TRY_AGAIN_LATER, 'send buffer exceeded')
      return
    }
    connection.socket.send(JSON.stringify(message))
  }

  #error(connection: Connection, code: string, message: string): void {
    this.#send(connection, { v: WS_PROTOCOL_VERSION, type: 'error', data: { code, message } })
  }

  #close(connection: Connection, code: number, reason: string): void {
    if (connection.closed) return
    connection.closed = true
    this.#unregister(connection)
    try {
      connection.socket.close(code, reason)
    } catch {
      // Already gone.
    }
    this.#log.info('ws.closed', {
      connectionId: connection.id,
      userId: connection.identity.userId,
      closeCode: code,
    })
  }

  #unregister(connection: Connection): void {
    this.#byId.delete(connection.id)
    const mine = this.#byUser.get(connection.identity.userId)
    mine?.delete(connection.id)
    if (mine?.size === 0) this.#byUser.delete(connection.identity.userId)
  }
}
