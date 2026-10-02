/**
 * The WebSocket client (docs/05 section 4, docs/03 section 11): one connection per tab, reconnecting with exponential
 * backoff and jitter, a server-time offset from `hello`, an application-level heartbeat, and the close-code policy
 * of the protocol table. M1 speaks hello / ping / pong / error only; messages with content arrive with M2.
 */
import { WS_CLOSE, WS_PROTOCOL_VERSION, wsServerMessageSchema } from '@chatapp/contracts'
import { create } from 'zustand'

export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped'

export type StopReason = 'unauthenticated' | 'origin' | 'manual'

type RealtimeState = {
  status: RealtimeStatus
  /** Close code of the last connection that ended, null before the first one. */
  lastCloseCode: number | null
  /** serverTime - Date.now() at the last `hello`; add it to Date.now() to get server time. */
  clockOffsetMs: number
  connectionId: string | null
}

export const useRealtime = create<RealtimeState>()(() => ({
  status: 'idle',
  lastCloseCode: null,
  clockOffsetMs: 0,
  connectionId: null,
}))

/** Server time as the client estimates it, for time-limited actions (recall window, docs/03 section 11). */
export function serverNow(): number {
  return Date.now() + useRealtime.getState().clockOffsetMs
}

export type FocusState = { conversationId: string | null; foreground: boolean }

export type RealtimeOptions = {
  url: string
  /** The server ended our session (4401): the caller resets the client and goes to the sign-in page. */
  onSessionLost: () => void
  /** Constructor and timers are injectable for tests. */
  WebSocketImpl?: typeof WebSocket
  setTimeoutImpl?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeoutImpl?: (id: ReturnType<typeof setTimeout>) => void
  random?: () => number
  now?: () => number
  isHidden?: () => boolean
  /** The server understands the `focus` message (M2/M6). Until then the state is tracked but never sent. */
  focusSupported?: boolean
}

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000
const HEARTBEAT_FALLBACK_MS = 25_000
/** A pong must arrive this long after our ping, or the connection is considered dead. */
const PONG_TIMEOUT_MS = 10_000

/** Delay before reconnect attempt number `attempt` (0-based): 1, 2, 4, 8 ... capped at 30 s, with ±20% jitter. */
export function backoffDelay(attempt: number, random: () => number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.round(base * (0.8 + 0.4 * random()))
}

export class RealtimeClient {
  readonly #options: RealtimeOptions
  readonly #WS: typeof WebSocket
  readonly #setTimeout: NonNullable<RealtimeOptions['setTimeoutImpl']>
  readonly #clearTimeout: NonNullable<RealtimeOptions['clearTimeoutImpl']>
  readonly #random: () => number
  readonly #now: () => number
  readonly #isHidden: () => boolean
  #socket: WebSocket | undefined
  #attempt = 0
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  #pongTimer: ReturnType<typeof setTimeout> | undefined
  #running = false
  #focus: FocusState = { conversationId: null, foreground: true }

  constructor(options: RealtimeOptions) {
    this.#options = options
    this.#WS = options.WebSocketImpl ?? WebSocket
    this.#setTimeout = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms))
    this.#clearTimeout = options.clearTimeoutImpl ?? ((id) => clearTimeout(id))
    this.#random = options.random ?? Math.random
    this.#now = options.now ?? Date.now
    this.#isHidden = options.isHidden ?? (() => document.visibilityState === 'hidden')
  }

  /** Starts (or resumes) the connection. Safe to call repeatedly. */
  start(): void {
    this.#running = true
    if (this.#socket || this.#retryTimer !== undefined) return
    this.#connect()
  }

  /** Closes the connection and stays closed until `start()`. */
  stop(reason: StopReason = 'manual'): void {
    this.#running = false
    this.#clearTimers()
    const socket = this.#socket
    this.#socket = undefined
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
      try {
        socket.close(1000, 'client stop')
      } catch {
        // Already closed.
      }
    }
    useRealtime.setState({
      status: reason === 'manual' ? 'idle' : 'stopped',
      connectionId: null,
    })
  }

  /** Call when the tab comes back to the foreground or the network returns: reconnects without waiting. */
  nudge(): void {
    if (!this.#running || this.#socket) return
    this.#clearRetry()
    this.#connect()
  }

  /** Records which conversation is open and whether the page is in front (docs/05 section 4.3, `focus`). */
  setFocus(next: Partial<FocusState>): void {
    this.#focus = { ...this.#focus, ...next }
    if (this.#options.focusSupported && this.#socket?.readyState === 1) {
      this.#socket.send(
        JSON.stringify({ v: WS_PROTOCOL_VERSION, type: 'focus', data: this.#focus }),
      )
    }
  }

  get focus(): FocusState {
    return this.#focus
  }

  #connect(): void {
    this.#clearRetry()
    useRealtime.setState({ status: this.#attempt === 0 ? 'connecting' : 'reconnecting' })
    let socket: WebSocket
    try {
      socket = new this.#WS(this.#options.url)
    } catch {
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket
    socket.onmessage = (event: MessageEvent<unknown>) => this.#onMessage(socket, event.data)
    socket.onclose = (event: CloseEvent) => this.#onClose(socket, event.code)
    // The browser reports a failed connection as `error` followed by `close`; the close handler does the work.
    socket.onerror = () => undefined
  }

  #onMessage(socket: WebSocket, data: unknown): void {
    if (socket !== this.#socket || typeof data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    // Unknown types are ignored (docs/05 section 4.2).
    const message = wsServerMessageSchema.safeParse(parsed)
    if (!message.success) return
    switch (message.data.type) {
      case 'hello': {
        const { connectionId, serverTime, heartbeatMs } = message.data.data
        this.#attempt = 0
        useRealtime.setState({
          status: 'open',
          connectionId,
          lastCloseCode: null,
          clockOffsetMs: Date.parse(serverTime) - this.#now(),
        })
        this.#scheduleHeartbeat(heartbeatMs || HEARTBEAT_FALLBACK_MS)
        break
      }
      case 'pong': {
        this.#clearPong()
        useRealtime.setState({
          clockOffsetMs: Date.parse(message.data.data.serverTime) - this.#now(),
        })
        break
      }
      case 'error':
        break
    }
  }

  #scheduleHeartbeat(intervalMs: number): void {
    this.#clearHeartbeat()
    this.#heartbeatTimer = this.#setTimeout(() => {
      const socket = this.#socket
      if (socket?.readyState !== 1) return
      socket.send(JSON.stringify({ v: WS_PROTOCOL_VERSION, type: 'ping', data: {} }))
      this.#pongTimer = this.#setTimeout(() => {
        // No answer: the path is dead although the socket looks open. Drop it and reconnect.
        this.#onClose(socket, WS_CLOSE.HEARTBEAT_TIMEOUT)
        try {
          socket.close()
        } catch {
          // Already closed.
        }
      }, PONG_TIMEOUT_MS)
      this.#scheduleHeartbeat(intervalMs)
    }, intervalMs)
  }

  #onClose(socket: WebSocket, code: number): void {
    if (socket !== this.#socket) return
    this.#socket = undefined
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null
    this.#clearHeartbeat()
    this.#clearPong()
    useRealtime.setState({ lastCloseCode: code, connectionId: null })
    if (!this.#running) return

    switch (code) {
      case WS_CLOSE.UNAUTHENTICATED:
        // The session ended. Do not reconnect: clear the client and go to the sign-in page.
        this.stop('unauthenticated')
        this.#options.onSessionLost()
        return
      case WS_CLOSE.ORIGIN_NOT_ALLOWED:
        this.stop('origin')
        return
      case WS_CLOSE.HEARTBEAT_TIMEOUT:
        this.#attempt = 0
        this.#reconnectNow()
        return
      case WS_CLOSE.TOO_MANY_CONNECTIONS:
        // A newer tab took over. A page in the background stays quiet instead of fighting for the slot.
        if (this.#isHidden()) {
          useRealtime.setState({ status: 'idle' })
          return
        }
        this.#scheduleReconnect()
        return
      default:
        // 4429, 1012, 1013, a network drop (1006) and anything else: back off, then try again.
        this.#scheduleReconnect()
    }
  }

  #reconnectNow(): void {
    useRealtime.setState({ status: 'reconnecting' })
    this.#retryTimer = this.#setTimeout(() => {
      this.#retryTimer = undefined
      this.#connect()
    }, 0)
  }

  #scheduleReconnect(): void {
    const delay = backoffDelay(this.#attempt, this.#random)
    this.#attempt += 1
    useRealtime.setState({ status: 'reconnecting' })
    this.#retryTimer = this.#setTimeout(() => {
      this.#retryTimer = undefined
      if (this.#running) this.#connect()
    }, delay)
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) this.#clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) this.#clearTimeout(this.#heartbeatTimer)
    this.#heartbeatTimer = undefined
  }

  #clearPong(): void {
    if (this.#pongTimer !== undefined) this.#clearTimeout(this.#pongTimer)
    this.#pongTimer = undefined
  }

  #clearTimers(): void {
    this.#clearRetry()
    this.#clearHeartbeat()
    this.#clearPong()
  }
}

/** `/ws` on the page's own origin (the dev server proxies it, Nginx does in production). */
export function realtimeUrl(
  location: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
}
