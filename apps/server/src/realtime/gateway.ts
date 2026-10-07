/**
 * WebSocket gateway (docs/03 sections 5.6-5.8 and 6, docs/05 section 4, SEC-03, SEC-24, SEC-27).
 *
 * A connection belongs to ONE login session. It stays open only while that session, its account, its auth epoch and its
 * device origin keep checking out: revocation hints (Pub/Sub) re-check at once, and every `revalidateMs` (5 s) the
 * gateway re-checks all connections against Postgres. If the check itself fails the gateway fails closed (1013).
 *
 * On top of that identity the gateway routes. A connection follows `conv:{id}` for every conversation its person is in,
 * recomputed from the database when a hint says their conversations changed, and again by the 5-second backstop when
 * their own log has moved (a lost hint costs at most those seconds). What the gateway believes about a person's
 * conversations is ONE record per person (`Following`), changed in two ways only: a reading of the database that began
 * after the latest hint, applied whole together with the number of their log it is true at; or, ahead of that reading,
 * the removal a hint announces. Readings run one at a time per person, so an answer that was slow cannot arrive after,
 * and undo, a newer one (D-137). Ordinary events are hints without content (SEC-27):
 * the topic only decides who is told that something changed; what they may read is decided over HTTP. Typing and
 * presence are best-effort signals and travel through the bus too, so every process delivers them to its own watchers.
 * The gateway only holds an abstract `Socket`; the Bun binding lives in runtime/server.ts.
 */
import {
  convTopic,
  LIMITS,
  type PresenceStatus,
  presenceTopic,
  userTopic,
  WS_CLOSE,
  WS_PROTOCOL_VERSION,
  type WsClientMessage,
  type WsServerMessage,
  wsClientMessageSchema,
} from '@chatapp/contracts'
import type { Deps } from '../domain/deps.ts'
import {
  loadLastSeen,
  loadMembershipSnapshots,
  loadUserChangeSeqs,
  type MembershipSnapshot,
  touchLastSeen,
} from '../domain/presence.ts'
import { type SessionRef, validateSessions } from '../domain/sessions.ts'
import { describeError, type Logger } from '../lib/logger.ts'
import type { EventBus } from './bus.ts'
import type { BusEvent } from './events.ts'
import { Hub } from './hub.ts'
import type { PresenceChange, PresenceStore } from './presence.ts'

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

/**
 * What turns the gateway from an identity check into a chat gateway. Without it (the unit tests with fake sockets) a
 * connection gets its `hello` at once and follows no topics.
 */
export type GatewayServices = {
  bus: EventBus
  presence: PresenceStore
  /**
   * Where a person's conversations are read from. The database, unless a test stands between the gateway and it to
   * hold or reorder the answers.
   */
  memberships?: (userIds: readonly string[]) => Promise<Map<string, MembershipSnapshot>>
}

/** What the gateway believes about one person's conversations, and how far that belief reaches (D-137). */
type Following = {
  /** The conversations every connection of this person follows. */
  conversations: Set<string>
  /** The number of the person's own log that `conversations` is known to include. */
  seq: number
  /** The reading in flight, if any. One at a time, so answers cannot come out of order. */
  reading: Promise<void> | undefined
  /** Something arrived while a reading was in flight: what it returns may predate it, so read once more. */
  again: boolean
}

export type ConnectionIdentity = {
  sessionId: string
  userId: string
  originId: string
  authEpoch: number
  restoreEpoch: string
}

/** A server message without its envelope fields, which the sender adds (`Omit` on a union would lose its members). */
type Payload<T> = T extends unknown ? Omit<T, 'v' | 'topic'> : never

export type Connection = {
  readonly id: string
  readonly socket: Socket
  readonly identity: ConnectionIdentity
  lastActivity: number
  windowStart: number
  windowCount: number
  closed: boolean
  /** The `hello` went out: from here on events are sent. Subscriptions are in place before that. */
  ready: boolean
  /** `conv:` topics followed: the server's own view of the person's conversations. */
  readonly topics: Set<string>
  /** `presence:` topics followed: the people whose online status this connection watches. */
  readonly watching: Set<string>
  readonly typingSentAt: Map<string, number>
  /** Whether presence knows this connection (so closing it has something to remove). */
  inPresence: boolean
}

export class Gateway {
  readonly #deps: Pick<Deps, 'db' | 'clock' | 'config' | 'newId'>
  readonly #log: Logger
  readonly #config: GatewayConfig
  readonly #now: () => number
  readonly #services: GatewayServices | undefined
  readonly #hub = new Hub<Connection>()
  readonly #byId = new Map<string, Connection>()
  readonly #byUser = new Map<string, Set<string>>()
  readonly #following = new Map<string, Following>()
  #timers: ReturnType<typeof setInterval>[] = []
  #checking: Promise<void> | undefined

  constructor(
    deps: Pick<Deps, 'db' | 'clock' | 'config' | 'newId'>,
    log: Logger,
    config: GatewayConfig,
    now: () => number = Date.now,
    services?: GatewayServices,
  ) {
    this.#deps = deps
    this.#log = log
    this.#config = config
    this.#now = now
    this.#services = services
  }

  get connectionCount(): number {
    return this.#byId.size
  }

  /** Followers of a topic, for tests and monitoring. */
  followers(topic: string): number {
    return this.#hub.count(topic)
  }

  /** For tests: resolves once nobody's conversations are being read (every reading has been applied or has failed). */
  async settled(): Promise<void> {
    for (;;) {
      const running = [...this.#following.values()]
        .map((following) => following.reading)
        .filter((reading): reading is Promise<void> => reading !== undefined)
      if (running.length === 0) return
      await Promise.allSettled(running)
    }
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

  /** Test environment only (V-14): drops the connections of one person, or all, with the given close code. */
  disconnect(options: { userId?: string; code?: number } = {}): number {
    const code = options.code ?? WS_CLOSE.TRY_AGAIN_LATER
    const targets = options.userId
      ? [...(this.#byUser.get(options.userId) ?? [])]
          .map((id) => this.#byId.get(id))
          .filter((c): c is Connection => c !== undefined)
      : [...this.#byId.values()]
    for (const connection of targets) this.#close(connection, code, 'disconnected for a test')
    return targets.length
  }

  /**
   * Registers an authenticated socket and enforces the per-user cap (oldest goes, 4409). With services the connection
   * first follows its person's conversations and announces itself, and only then greets with `hello`: whatever the
   * client reads after `hello` is covered by what it is subscribed to. Without them it greets at once.
   */
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
      ready: false,
      topics: new Set(),
      watching: new Set(),
      typingSentAt: new Map(),
      inPresence: false,
    }
    this.#byId.set(connection.id, connection)
    const mine = this.#byUser.get(identity.userId) ?? new Set<string>()
    this.#byUser.set(identity.userId, mine)
    mine.add(connection.id)
    if (!this.#following.has(identity.userId)) {
      this.#following.set(identity.userId, {
        conversations: new Set(),
        seq: 0,
        reading: undefined,
        again: false,
      })
    }
    while (mine.size > this.#config.maxConnectionsPerUser) {
      const oldest = mine.values().next().value
      const victim = oldest === undefined ? undefined : this.#byId.get(oldest)
      if (!victim || victim === connection) break
      this.#close(victim, WS_CLOSE.TOO_MANY_CONNECTIONS, 'too many connections')
    }
    this.#log.info('ws.connected', { connectionId: connection.id, userId: identity.userId })
    if (this.#services) void this.#start(connection, this.#services)
    else this.#greet(connection)
    return connection
  }

  #greet(connection: Connection): void {
    connection.ready = true
    this.#send(connection, {
      v: WS_PROTOCOL_VERSION,
      type: 'hello',
      data: {
        connectionId: connection.id,
        userId: connection.identity.userId,
        authEpoch: connection.identity.authEpoch,
        restoreEpoch: connection.identity.restoreEpoch,
        serverTime: this.#deps.clock.now().toISOString(),
        heartbeatMs: this.#config.heartbeatMs,
      },
    })
  }

  async #start(connection: Connection, services: GatewayServices): Promise<void> {
    const { userId } = connection.identity
    try {
      // A reading that begins now and is applied to every connection of the person, this one included: whatever
      // happens after `hello` is covered by what the connection follows.
      await this.#read(userId)
      if (connection.closed) return
      const change = await services.presence.connect(
        { userId, connectionId: connection.id },
        this.#now(),
      )
      connection.inPresence = true
      if (connection.closed) {
        void this.#leavePresence(connection)
        return
      }
      this.#announce(userId, change)
      this.#greet(connection)
    } catch (error) {
      this.#log.warn('ws.start_failed', describeError(error))
      this.#close(connection, WS_CLOSE.TRY_AGAIN_LATER, 'dependency unavailable')
    }
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
    this.#handle(connection, message.data)
  }

  #handle(connection: Connection, message: WsClientMessage): void {
    switch (message.type) {
      case 'ping':
        this.#send(connection, {
          v: WS_PROTOCOL_VERSION,
          type: 'pong',
          data: { serverTime: this.#deps.clock.now().toISOString() },
        })
        return
      case 'typing':
        this.#typing(connection, message.data)
        return
      case 'presence.watch':
        void this.#watch(connection, message.data.userIds)
        return
      case 'presence.activity':
        void this.#activity(connection, message.data.state)
        return
      case 'focus':
        void this.#focus(connection, message.data)
        return
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

  // ───────── events from the bus ─────────

  /** An event from the bus. Hints name what changed; who is told is decided by the topics each connection follows. */
  handleEvent(event: BusEvent): void {
    switch (event.type) {
      case 'auth.revoked':
        void this.revalidateUser(event.userId)
        return
      case 'work.wake':
        return
      case 'message.changed':
        this.#fanOut(convTopic(event.conversationId), {
          type: 'message.changed',
          data: {
            conversationId: event.conversationId,
            messageId: event.messageId,
            changeSeq: event.changeSeq,
          },
        })
        return
      case 'conversation.changed':
        this.#fanOut(convTopic(event.conversationId), {
          type: 'conversation.changed',
          data: { conversationId: event.conversationId, metadataVersion: event.metadataVersion },
        })
        return
      case 'member.changed':
        this.#fanOut(convTopic(event.conversationId), {
          type: 'member.changed',
          data: {
            conversationId: event.conversationId,
            membershipVersion: event.membershipVersion,
          },
        })
        return
      case 'attachment.updated':
        this.#tellUser(event.userId, {
          type: 'attachment.updated',
          data: {
            attachmentId: event.attachmentId,
            generation: event.generation,
            version: event.version,
          },
        })
        return
      case 'user.changed': {
        this.#tellUser(event.userId, {
          type: 'user.changed',
          data: { userChangeSeq: event.userChangeSeq },
        })
        if (event.membership) this.#refresh([event.userId])
        return
      }
      case 'conversation.removed': {
        // Stop following at once, ahead of the reading: the hint says this person lost the conversation. Only while it
        // is news, though: one that is not newer than what the gateway already holds (it arrived late, perhaps after
        // the person came back) must not take the conversation away again; the reading below settles it either way.
        if (this.#unseen(event.userId, event.userChangeSeq)) {
          this.#stopFollowing(event.userId, event.conversationId)
        }
        this.#refresh([event.userId])
        this.#tellUser(event.userId, {
          type: 'conversation.removed',
          data: { conversationId: event.conversationId, userChangeSeq: event.userChangeSeq },
        })
        return
      }
      case 'typing':
        this.#fanOut(
          convTopic(event.conversationId),
          {
            type: 'typing',
            data: {
              conversationId: event.conversationId,
              userId: event.userId,
              state: event.state,
              expiresInMs: LIMITS.typingExpiresMs,
            },
          },
          (connection) => connection.identity.userId === event.userId,
        )
        return
      case 'presence':
        this.#fanOut(presenceTopic(event.userId), {
          type: 'presence',
          data: { userId: event.userId, status: event.status, lastSeenAt: event.lastSeenAt },
        })
        return
    }
  }

  /** Stringified once and written to every follower that is ready, minus those the filter excludes. */
  #fanOut(
    topic: string,
    message: Payload<WsServerMessage>,
    exclude?: (connection: Connection) => boolean,
  ): void {
    const followers = this.#hub.subscribers(topic)
    if (followers.length === 0) return
    const text = JSON.stringify({ v: WS_PROTOCOL_VERSION, topic, ...message })
    for (const connection of followers) {
      if (connection.closed || !connection.ready || exclude?.(connection)) continue
      this.#sendText(connection, text)
    }
  }

  #tellUser(userId: string, message: Payload<WsServerMessage>): void {
    const text = JSON.stringify({ v: WS_PROTOCOL_VERSION, topic: userTopic(userId), ...message })
    for (const connection of this.#connectionsOf(userId)) {
      if (!connection.closed && connection.ready) this.#sendText(connection, text)
    }
  }

  #connectionsOf(userId: string): Connection[] {
    return [...(this.#byUser.get(userId) ?? [])]
      .map((id) => this.#byId.get(id))
      .filter((c): c is Connection => c !== undefined)
  }

  // ───────── subscriptions ─────────

  /** Moves a connection's `conv:` subscriptions to exactly this set of conversations. */
  #follow(connection: Connection, conversationIds: ReadonlySet<string>): void {
    const wanted = new Set([...conversationIds].map(convTopic))
    for (const topic of [...connection.topics]) {
      if (!wanted.has(topic)) {
        connection.topics.delete(topic)
        this.#hub.unsubscribe(topic, connection)
      }
    }
    for (const topic of wanted) {
      if (!connection.topics.has(topic)) {
        connection.topics.add(topic)
        this.#hub.subscribe(topic, connection)
      }
    }
  }

  /** Whether a hint announces a change of this person's log that what the gateway holds does not yet include. */
  #unseen(userId: string, userChangeSeq: number): boolean {
    const following = this.#following.get(userId)
    return following !== undefined && userChangeSeq > following.seq
  }

  /** Ahead of any reading: this person has lost this conversation, so none of their connections follows it. */
  #stopFollowing(userId: string, conversationId: string): void {
    this.#following.get(userId)?.conversations.delete(conversationId)
    const topic = convTopic(conversationId)
    for (const connection of this.#connectionsOf(userId)) {
      if (connection.topics.delete(topic)) this.#hub.unsubscribe(topic, connection)
    }
  }

  /** Asks for a fresh reading for each of these people. Failures wait for the 5-second backstop. */
  #refresh(userIds: readonly string[]): void {
    for (const userId of userIds) {
      void this.#read(userId).catch((error) => {
        this.#log.warn('ws.refresh_failed', describeError(error))
      })
    }
  }

  /**
   * Reads a person's conversations from the database and applies them to all their connections. One reading at a time
   * per person; a request that comes in while one runs does not start a second but marks the first as possibly
   * outdated, and it is repeated before anything is applied, so what is applied always began after the newest request.
   * Resolves once a reading that began after this call has been applied (or rejects when the database could not be read).
   */
  #read(userId: string): Promise<void> {
    const following = this.#following.get(userId)
    if (!following) return Promise.resolve()
    if (following.reading) {
      following.again = true
      return following.reading
    }
    const reading = (async () => {
      try {
        for (;;) {
          following.again = false
          const load =
            this.#services?.memberships ?? ((ids) => loadMembershipSnapshots(this.#deps, ids))
          const snapshot = (await load([userId])).get(userId)
          if (following.again) continue
          this.#apply(userId, following, snapshot)
          return
        }
      } finally {
        following.reading = undefined
      }
    })()
    following.reading = reading
    return reading
  }

  /** The belief and the number it is true at change together, and reach every connection of the person. */
  #apply(userId: string, following: Following, snapshot: MembershipSnapshot | undefined): void {
    // The person's last connection went while the database was being read: the record is gone, and so is the point.
    if (this.#following.get(userId) !== following) return
    following.conversations = new Set(snapshot?.conversationIds)
    following.seq = snapshot?.userChangeSeq ?? 0
    for (const connection of this.#connectionsOf(userId)) {
      if (!connection.closed) this.#follow(connection, following.conversations)
    }
  }

  /**
   * The backstop for lost hints: a person's own log moves whenever their conversations may have changed, so comparing
   * one number per person tells whose conversations need reading again. One cheap query per interval.
   */
  async #syncMemberships(): Promise<void> {
    const users = [...this.#following.keys()]
    if (users.length === 0) return
    const heads = await loadUserChangeSeqs(this.#deps, users)
    const stale = users.filter(
      (userId) => (heads.get(userId) ?? 0) > (this.#following.get(userId)?.seq ?? 0),
    )
    await Promise.all(
      stale.map((userId) =>
        this.#read(userId).catch((error) => {
          this.#log.warn('ws.refresh_failed', describeError(error))
        }),
      ),
    )
  }

  // ───────── client signals ─────────

  #typing(connection: Connection, data: { conversationId: string; state: 'start' | 'stop' }): void {
    if (!this.#services || !connection.ready) return
    // Following the conversation is the gateway's own view of membership: a person who is not in it is simply ignored.
    if (!connection.topics.has(convTopic(data.conversationId))) return
    const now = this.#now()
    if (data.state === 'start') {
      const last = connection.typingSentAt.get(data.conversationId) ?? Number.NEGATIVE_INFINITY
      if (now - last < LIMITS.typingMinIntervalMs) return
      connection.typingSentAt.set(data.conversationId, now)
    } else {
      connection.typingSentAt.delete(data.conversationId)
    }
    void this.#services.bus
      .publish({
        type: 'typing',
        conversationId: data.conversationId,
        userId: connection.identity.userId,
        state: data.state,
      })
      .catch(() => undefined)
  }

  /** Replaces the set of people whose presence this connection follows and answers with where they all stand. */
  async #watch(connection: Connection, userIds: readonly string[]): Promise<void> {
    const services = this.#services
    if (!services || !connection.ready) return
    const wanted = new Set(userIds)
    for (const id of [...connection.watching]) {
      if (!wanted.has(id)) {
        connection.watching.delete(id)
        this.#hub.unsubscribe(presenceTopic(id), connection)
      }
    }
    for (const id of wanted) {
      if (!connection.watching.has(id)) {
        connection.watching.add(id)
        this.#hub.subscribe(presenceTopic(id), connection)
      }
    }
    try {
      const ids = [...wanted]
      const statuses = await services.presence.statuses(ids, this.#now())
      const offline = ids.filter((id) => (statuses.get(id) ?? 'offline') === 'offline')
      const seen = await loadLastSeen(this.#deps, offline)
      this.#send(connection, {
        v: WS_PROTOCOL_VERSION,
        type: 'presence.snapshot',
        data: {
          users: ids.map((userId) => {
            const status: PresenceStatus = statuses.get(userId) ?? 'offline'
            return {
              userId,
              status,
              lastSeenAt: status === 'offline' ? (seen.get(userId)?.toISOString() ?? null) : null,
            }
          }),
        },
      })
    } catch (error) {
      this.#log.warn('ws.presence_snapshot_failed', describeError(error))
    }
  }

  async #activity(connection: Connection, state: 'active' | 'idle'): Promise<void> {
    const services = this.#services
    if (!services || !connection.ready || connection.closed) return
    try {
      const change = await services.presence.setActivity(
        { userId: connection.identity.userId, connectionId: connection.id },
        state,
        this.#now(),
      )
      this.#announce(connection.identity.userId, change)
    } catch (error) {
      this.#log.warn('ws.presence_failed', describeError(error))
    }
  }

  /** What the page shows, and whether it is in front: kept for the notification rules (M6) and never used to authorize. */
  async #focus(
    connection: Connection,
    data: { conversationId: string | null; foreground: boolean },
  ): Promise<void> {
    const services = this.#services
    if (!services || !connection.ready || connection.closed) return
    // A conversation the person is not in is not "focus": it is treated as looking at nothing.
    const conversationId =
      data.conversationId !== null && connection.topics.has(convTopic(data.conversationId))
        ? data.conversationId
        : null
    try {
      await services.presence.setFocus(
        { userId: connection.identity.userId, connectionId: connection.id },
        { conversationId, foreground: data.foreground },
      )
    } catch (error) {
      this.#log.warn('ws.focus_failed', describeError(error))
    }
  }

  // ───────── presence ─────────

  /** Announces a change of status on the bus (every process delivers it to its watchers); an unchanged status says nothing. */
  #announce(userId: string, change: PresenceChange): void {
    if (change.previous === change.current || !this.#services) return
    void this.#publishPresence(userId, change.current)
  }

  async #publishPresence(userId: string, status: PresenceStatus): Promise<void> {
    const services = this.#services
    if (!services) return
    try {
      let lastSeenAt: string | null = null
      if (status === 'offline') {
        // The last connection went: this moment is when they were last seen (docs/03 section 5.6, step 5).
        const at = this.#deps.clock.now()
        await touchLastSeen(this.#deps, userId, at)
        lastSeenAt = at.toISOString()
      }
      await services.bus.publish({ type: 'presence', userId, status, lastSeenAt })
    } catch (error) {
      this.#log.warn('ws.presence_publish_failed', describeError(error))
    }
  }

  async #leavePresence(connection: Connection): Promise<void> {
    const services = this.#services
    if (!services) return
    try {
      const change = await services.presence.disconnect(
        { userId: connection.identity.userId, connectionId: connection.id },
        this.#now(),
      )
      this.#announce(connection.identity.userId, change)
    } catch (error) {
      this.#log.warn('ws.presence_leave_failed', describeError(error))
    }
  }

  async #renewPresence(): Promise<void> {
    const services = this.#services
    if (!services) return
    for (const connection of [...this.#byId.values()]) {
      if (connection.closed || !connection.inPresence) continue
      try {
        const change = await services.presence.renew(
          { userId: connection.identity.userId, connectionId: connection.id },
          this.#now(),
        )
        this.#announce(connection.identity.userId, change)
      } catch {
        // The next heartbeat tries again; a dead connection simply expires.
      }
    }
  }

  // ───────── identity ─────────

  async revalidateUser(userId: string): Promise<void> {
    const ids = this.#byUser.get(userId)
    if (!ids) return
    await this.#revalidate(
      [...ids].map((id) => this.#byId.get(id)).filter((c): c is Connection => c !== undefined),
    )
  }

  /**
   * The bus has come back after being away: every hint published meanwhile is gone, so look at the database now (who may
   * still be connected, and what each person is in) instead of at the next tick (docs/03 section 5.7). A recheck that is
   * already running began before the bus returned, so one more is run after it.
   */
  async afterBusRecovered(): Promise<void> {
    this.#log.info('bus.recovered')
    if (this.#checking) await this.#checking.catch(() => undefined)
    await this.revalidateAll()
  }

  /** Periodic backstop (5 s): also catches revocations whose hint was lost. Overlapping runs are skipped. */
  async revalidateAll(): Promise<void> {
    if (this.#checking) return
    this.#checking = (async () => {
      await this.#revalidate([...this.#byId.values()])
      if (!this.#services) return
      try {
        await this.#syncMemberships()
      } catch (error) {
        this.#log.warn('ws.membership_sync_failed', describeError(error))
      }
    })().finally(() => {
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

  /** 25 s: send a protocol ping and renew presence; 60 s without any sign of life: 4408. */
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
    void this.#renewPresence()
  }

  // ───────── sending and closing ─────────

  #send(connection: Connection, message: WsServerMessage): void {
    this.#sendText(connection, JSON.stringify(message))
  }

  #sendText(connection: Connection, text: string): void {
    if (connection.closed) return
    if (connection.socket.bufferedAmount() > this.#config.sendBufferBytes) {
      // A slow client is disconnected instead of buffering without bound; it resynchronizes when it reconnects.
      this.#close(connection, WS_CLOSE.TRY_AGAIN_LATER, 'send buffer exceeded')
      return
    }
    connection.socket.send(text)
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
    if (mine?.size === 0) {
      this.#byUser.delete(connection.identity.userId)
      this.#following.delete(connection.identity.userId)
    }
    for (const topic of connection.topics) this.#hub.unsubscribe(topic, connection)
    for (const id of connection.watching) this.#hub.unsubscribe(presenceTopic(id), connection)
    connection.topics.clear()
    connection.watching.clear()
    if (connection.inPresence) {
      connection.inPresence = false
      void this.#leavePresence(connection)
    }
  }
}
