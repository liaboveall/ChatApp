/**
 * Messages the person has sent that the server has not answered yet (docs/01 section 4.5, D-154). A message shows up at
 * once as "sending"; those of one conversation go out one at a time, in the order they were typed; a failure marks that one
 * as failed (retry sends it again with the *same* `clientId`, which the server answers idempotently, so a retry can never
 * make a duplicate) and the ones behind it go on. Cleared with the account and with a conversation's line when the
 * membership the messages were written under ends (D-171); what a request that was still out brings back after that is
 * dropped.
 *
 * Plain text can also wait for the network (M6, D-205). A message that cannot reach the server, or that is written while the
 * browser knows it is offline, is "offline": it stays in its line, in order, and is sent by itself when the network is back,
 * through the queue endpoint (docs/05 section 3.4), which never moves the person's read position. Before it goes, the
 * account is asked for again and the conversation is read again, so what is sent is sent as the person who wrote it and under
 * the membership it was written under. A message older than 24 hours, or written under a membership that has ended, is not
 * sent by itself: it is marked failed and stays for the person to send again or delete.
 */
import type {
  Attachment,
  MessageEnvelope,
  ReplayMessageRequest,
  ReplyTo,
  SendMessageRequest,
} from '@chatapp/contracts'
import { create } from 'zustand'
import { ApiError } from '../api.ts'
import { isStale } from '../offline/policy.ts'
import { registerConversationReset, registerStoreReset } from './stores.ts'
import type { RequestTicket } from './types.ts'

export type PendingState = 'queued' | 'sending' | 'offline' | 'failed'

export type PendingMessage = {
  clientId: string
  conversationId: string
  /** The membership the message was written under: after leaving and re-joining it is not sent on its own. */
  membershipId: string
  body: string
  attachments?: Attachment[]
  replyToId: string | null
  /** The quote shown in the pending bubble (a copy of what the quoted message showed when the person chose it). */
  quote: Extract<ReplyTo, { id: string }> | null
  /** When it was written, as the person's clock corrected by the server's time. */
  createdAt: string
  state: PendingState
  /** The stable error code of the last failed attempt, for the screen to word. */
  error: string | null
}

type OutboxState = { byConversation: Record<string, PendingMessage[]> }

export const useOutbox = create<OutboxState>()(() => ({ byConversation: {} }))

const NO_PENDING: PendingMessage[] = []

/** The pending messages of one conversation, in the order they were written (a stable empty list when there are none). */
export const pendingOf = (state: OutboxState, conversationId: string): PendingMessage[] =>
  state.byConversation[conversationId] ?? NO_PENDING

export type OutboxDeps = {
  send: (conversationId: string, request: SendMessageRequest) => Promise<MessageEnvelope>
  /** Taken when a message goes out: what its answer, or its failure, is checked against when it comes back (D-171). */
  ticket: (conversationId: string) => RequestTicket
  /**
   * The server accepted a message: it goes into the cache like every other answer (unless the ticket is out of date). `via`
   * says how it was sent: a message from the queue did not move the person's read position, so the screen must not count it
   * as read (AT-32).
   */
  onSent: (envelope: MessageEnvelope, ticket: RequestTicket, via: 'send' | 'replay') => void
  /** An error that may mean the conversation is gone for me; true when it was handled as that (then nothing is shown). */
  onAccessError: (conversationId: string, error: unknown, ticket: RequestTicket) => boolean
  /** The membership I hold in the conversation now. */
  membershipOf: (conversationId: string) => string | undefined
  now: () => number
  newId: () => string
  /** Waiting for the network (M6). Absent: a message that cannot be sent is a failure, as it always was. */
  queue?: QueueDeps
}

export type QueueDeps = {
  /** The queue endpoint: plain text written while the network was down, sent under the membership it was written under. */
  replay: (conversationId: string, request: ReplayMessageRequest) => Promise<MessageEnvelope>
  /** Whether the browser thinks it has a network. */
  isOnline: () => boolean
  /** Whether messages of the conversation may wait (not those to the assistant, which need an answer now). */
  canQueue: (conversationId: string) => boolean
  /** Asks the server who is signed in. False: not the account that wrote the queue (or nobody), so nothing is sent. */
  verifyAccount: () => Promise<boolean>
  /** Reads the conversation again, so that the membership held is the one the server says. Throws when it cannot be read. */
  verifyConversation: (conversationId: string) => Promise<void>
  random?: () => number
}

/** The queue is looked at again after this long, doubling while it keeps failing, up to the cap (with a little jitter). */
const RETRY_FIRST_MS = 5000
const RETRY_MAX_MS = 60_000

/** The answer never came, so nobody knows whether the server has the message: sending it again is harmless (same `clientId`). */
const isUnreachable = (error: unknown): boolean =>
  error instanceof ApiError && (error.code === 'NETWORK' || error.code === 'GATEWAY')

/** A failure of the queue endpoint that says nothing about the message itself: try again later. */
const isTransient = (error: unknown): boolean =>
  error instanceof ApiError &&
  (isUnreachable(error) ||
    error.code === 'REQUEST_TIMEOUT' ||
    error.code === 'RATE_LIMITED' ||
    error.code === 'CAPACITY_UNAVAILABLE' ||
    error.status >= 500)

export type EnqueueInput = {
  conversationId: string
  membershipId: string
  body: string
  attachments?: Attachment[]
  replyToId: string | null
  quote: PendingMessage['quote']
}

export class Outbox {
  readonly #deps: OutboxDeps
  #resuming = false
  #again = false
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #retryFailures = 0
  /** A server asked for patience (429): the next look at the queue waits at least this long. */
  #retryAfterMs = 0

  constructor(deps: OutboxDeps) {
    this.#deps = deps
  }

  #update(conversationId: string, change: (list: PendingMessage[]) => PendingMessage[]): void {
    useOutbox.setState((state) => {
      const next = change(state.byConversation[conversationId] ?? [])
      const { [conversationId]: _old, ...rest } = state.byConversation
      return { byConversation: next.length === 0 ? rest : { ...rest, [conversationId]: next } }
    })
  }

  #patch(clientId: string, conversationId: string, patch: Partial<PendingMessage>): void {
    this.#update(conversationId, (list) =>
      list.map((entry) => (entry.clientId === clientId ? { ...entry, ...patch } : entry)),
    )
  }

  /** Adds a message at the end of the conversation's line and starts sending it when its turn comes. */
  enqueue(input: EnqueueInput): PendingMessage {
    // Written without a network, or behind a message that is waiting for one: it waits too, so the order is kept.
    const waits =
      this.#mayWait(input) &&
      (this.#deps.queue?.isOnline() === false ||
        pendingOf(useOutbox.getState(), input.conversationId).some((e) => e.state === 'offline'))
    const pending: PendingMessage = {
      clientId: this.#deps.newId(),
      conversationId: input.conversationId,
      membershipId: input.membershipId,
      body: input.body,
      attachments: input.attachments,
      replyToId: input.replyToId,
      quote: input.quote,
      createdAt: new Date(this.#deps.now()).toISOString(),
      state: waits ? 'offline' : 'queued',
      error: null,
    }
    this.#update(input.conversationId, (list) => [...list, pending])
    if (waits) void this.resume()
    else void this.#pump(input.conversationId)
    return pending
  }

  /** Whether a message can wait for the network: plain text, in a conversation that takes it. */
  #mayWait(message: Pick<EnqueueInput, 'conversationId' | 'body' | 'attachments'>): boolean {
    const queue = this.#deps.queue
    return (
      queue !== undefined &&
      (message.attachments?.length ?? 0) === 0 &&
      message.body.trim() !== '' &&
      queue.canQueue(message.conversationId)
    )
  }

  /**
   * Puts back what was kept from an earlier visit (D-205): messages waiting for the network, and failed ones the person had
   * not dealt with. Ones already in a line (another tab's, or the same message) are left as they are. The queue is looked at
   * afterwards, which checks the account and the membership before anything goes out.
   */
  restore(messages: PendingMessage[]): void {
    const ordered = [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    for (const message of ordered) {
      if (
        pendingOf(useOutbox.getState(), message.conversationId).some(
          (e) => e.clientId === message.clientId,
        )
      )
        continue
      this.#update(message.conversationId, (list) => [...list, message])
    }
    void this.resume()
  }

  /** Sends a failed message again, with the same `clientId`. */
  retry(clientId: string, conversationId: string): void {
    const entry = pendingOf(useOutbox.getState(), conversationId).find(
      (p) => p.clientId === clientId,
    )
    if (entry === undefined || entry.state !== 'failed') return
    const membershipId = this.#deps.membershipOf(conversationId) ?? entry.membershipId
    this.#patch(clientId, conversationId, { state: 'queued', error: null, membershipId })
    void this.#pump(conversationId)
  }

  /** Throws a failed message away (only the local copy: nothing was ever accepted). */
  discard(clientId: string, conversationId: string): void {
    this.#update(conversationId, (list) => list.filter((entry) => entry.clientId !== clientId))
  }

  clearConversation(conversationId: string): void {
    this.#update(conversationId, () => [])
  }

  clearAll(): void {
    useOutbox.setState({ byConversation: {} })
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
    this.#retryFailures = 0
    this.#retryAfterMs = 0
  }

  /**
   * Whether the message is still the one in flight. Clearing a line (the conversation was forgotten, the account ended)
   * takes it away while its request is out, and what that request brings back belongs to what was cleared: it must not
   * reach the cache, the read position or the line of whoever uses this screen next (D-171, SEC-34).
   */
  #inFlight(conversationId: string, clientId: string): boolean {
    return pendingOf(useOutbox.getState(), conversationId).some(
      (entry) => entry.clientId === clientId && entry.state === 'sending',
    )
  }

  /** One at a time per conversation: the next queued message goes when none is in flight. */
  async #pump(conversationId: string): Promise<void> {
    const list = pendingOf(useOutbox.getState(), conversationId)
    if (list.some((entry) => entry.state === 'sending')) return
    // Messages waiting for the network go first, in order: nothing is sent past one of them.
    if (list.some((entry) => entry.state === 'offline')) {
      void this.resume()
      return
    }
    const next = list.find((entry) => entry.state === 'queued')
    if (next === undefined) return

    const current = this.#deps.membershipOf(conversationId)
    if (current !== undefined && current !== next.membershipId) {
      // Written under a membership that has ended: sending it now would put it into a conversation the person re-entered.
      this.#patch(next.clientId, conversationId, { state: 'failed', error: 'MEMBERSHIP_CHANGED' })
      return await this.#pump(conversationId)
    }

    this.#patch(next.clientId, conversationId, { state: 'sending' })
    const ticket = this.#deps.ticket(conversationId)
    try {
      const envelope = await this.#deps.send(conversationId, {
        clientId: next.clientId,
        ...(next.body.trim() ? { body: next.body } : {}),
        ...((next.attachments?.length ?? 0)
          ? { attachmentIds: next.attachments?.map((file) => file.id) }
          : {}),
        ...(next.replyToId === null ? {} : { replyToId: next.replyToId }),
      })
      if (!this.#inFlight(conversationId, next.clientId)) return
      // The answer goes into the cache first, then the pending copy goes: both land in the same render.
      this.#deps.onSent(envelope, ticket, 'send')
      this.#update(conversationId, (rows) =>
        rows.filter((entry) => entry.clientId !== next.clientId),
      )
    } catch (error) {
      if (!this.#inFlight(conversationId, next.clientId)) return
      if (this.#deps.onAccessError(conversationId, error, ticket)) {
        this.clearConversation(conversationId)
        return
      }
      if (isUnreachable(error) && this.#mayWait(next)) {
        // The answer never came. It waits, with the ones behind it, and goes again by itself: the same `clientId` makes a
        // second arrival harmless even if the first one got through.
        this.#park(conversationId, next.clientId)
        this.#armRetry(false)
        return
      }
      const code = error instanceof ApiError ? error.code : 'UNKNOWN'
      // Still there only if nobody discarded it while the request was in flight.
      this.#update(conversationId, (rows) =>
        rows.map((entry) =>
          entry.clientId === next.clientId ? { ...entry, state: 'failed', error: code } : entry,
        ),
      )
    }
    return await this.#pump(conversationId)
  }

  /** The message and every one behind it that can wait go to "offline": the line stops here until the network is back. */
  #park(conversationId: string, fromClientId: string): void {
    this.#update(conversationId, (list) => {
      let reached = false
      return list.map((entry) => {
        if (entry.clientId === fromClientId) reached = true
        return reached &&
          (entry.state === 'sending' || entry.state === 'queued') &&
          this.#mayWait(entry)
          ? { ...entry, state: 'offline', error: null }
          : entry
      })
    })
  }

  // ───────── The queue (M6) ─────────

  /**
   * Looks at the messages waiting for the network and sends what can be sent: called when the network is back, when the page
   * returns to the front, when the connection to the server is up again, after a restore, and by its own timer while
   * something is still waiting. One look at a time; a call during a look makes the look run once more.
   */
  async resume(): Promise<void> {
    if (this.#deps.queue === undefined) return
    if (this.#resuming) {
      this.#again = true
      return
    }
    this.#resuming = true
    let reached = true
    try {
      do {
        this.#again = false
        reached = await this.#replayAll()
      } while (this.#again)
    } finally {
      this.#resuming = false
    }
    this.#armRetry(reached)
  }

  #waiting(): string[] {
    return Object.entries(useOutbox.getState().byConversation)
      .filter(([, list]) => list.some((entry) => entry.state === 'offline'))
      .map(([conversationId]) => conversationId)
  }

  /** True when everything that was tried got an answer; false when the network (or a busy server) got in the way. */
  async #replayAll(): Promise<boolean> {
    const queue = this.#deps.queue
    const waiting = this.#waiting()
    if (queue === undefined || waiting.length === 0) return true
    if (!queue.isOnline()) return false
    try {
      // Before anything goes out: is the person who is signed in the one who wrote these? If not, or if nobody is, nothing is
      // sent; the end of the session (or the change of account) empties the lines.
      if (!(await queue.verifyAccount())) return true
    } catch {
      return false
    }
    for (const conversationId of waiting) {
      if (!(await this.#replayConversation(conversationId))) return false
    }
    return true
  }

  async #replayConversation(conversationId: string): Promise<boolean> {
    const queue = this.#deps.queue
    if (queue === undefined) return true
    try {
      await queue.verifyConversation(conversationId)
    } catch {
      return false
    }
    for (;;) {
      const list = pendingOf(useOutbox.getState(), conversationId)
      // A message is on its way by the ordinary route: this look is repeated when it ends.
      if (list.some((entry) => entry.state === 'sending')) return true
      const next = list.find((entry) => entry.state === 'offline')
      if (next === undefined) break

      if (isStale(next.createdAt, this.#deps.now())) {
        this.#patch(next.clientId, conversationId, { state: 'failed', error: 'QUEUE_EXPIRED' })
        continue
      }
      const current = this.#deps.membershipOf(conversationId)
      if (current !== undefined && current !== next.membershipId) {
        this.#patch(next.clientId, conversationId, { state: 'failed', error: 'MEMBERSHIP_CHANGED' })
        continue
      }

      this.#patch(next.clientId, conversationId, { state: 'sending' })
      const ticket = this.#deps.ticket(conversationId)
      try {
        const envelope = await queue.replay(conversationId, {
          clientId: next.clientId,
          body: next.body,
          ...(next.replyToId === null ? {} : { replyToId: next.replyToId }),
          queuedAt: next.createdAt,
          membershipId: next.membershipId,
        })
        if (!this.#inFlight(conversationId, next.clientId)) return true
        this.#deps.onSent(envelope, ticket, 'replay')
        this.#update(conversationId, (rows) =>
          rows.filter((entry) => entry.clientId !== next.clientId),
        )
      } catch (error) {
        if (!this.#inFlight(conversationId, next.clientId)) return true
        if (this.#deps.onAccessError(conversationId, error, ticket)) {
          this.clearConversation(conversationId)
          return true
        }
        const failure = this.#failureOf(error)
        if (failure === null) {
          // Nothing was decided about the message: it waits for the next look.
          this.#patch(next.clientId, conversationId, { state: 'offline' })
          if (error instanceof ApiError && error.retryAfterSeconds !== undefined) {
            this.#retryAfterMs = Math.max(this.#retryAfterMs, error.retryAfterSeconds * 1000)
          }
          return false
        }
        this.#patch(next.clientId, conversationId, { state: 'failed', error: failure })
      }
    }
    // Ordinary messages that were typed behind the queue go now.
    void this.#pump(conversationId)
    return true
  }

  /** What the queue endpoint's refusal means for the message: the code it is kept under, or null to wait and try again. */
  #failureOf(error: unknown): string | null {
    if (!(error instanceof ApiError)) return 'UNKNOWN'
    if (error.code === 'WINDOW_EXPIRED') return 'QUEUE_EXPIRED'
    if (error.status === 409 && error.reason === 'membership_changed') return 'MEMBERSHIP_CHANGED'
    if (error.reason === 'agent_conversation') return 'NOT_QUEUEABLE'
    return isTransient(error) ? null : error.code
  }

  #armRetry(reached: boolean): void {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer)
      this.#retryTimer = undefined
    }
    if (this.#waiting().length === 0) {
      this.#retryFailures = 0
      this.#retryAfterMs = 0
      return
    }
    if (reached) return
    this.#retryFailures += 1
    const random = this.#deps.queue?.random ?? Math.random
    const backoff = Math.min(RETRY_FIRST_MS * 2 ** (this.#retryFailures - 1), RETRY_MAX_MS)
    const delay = Math.max(backoff * (0.8 + random() * 0.4), this.#retryAfterMs)
    this.#retryAfterMs = 0
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined
      void this.resume()
    }, delay)
  }
}

// Nothing of a conversation survives the account: the engine empties the registered stores when it stops, and the
// conversation's own line when its membership ends.
registerStoreReset(() => useOutbox.setState({ byConversation: {} }))
registerConversationReset((conversationId, reason) =>
  useOutbox.setState((state) => {
    const line = state.byConversation[conversationId]
    if (line === undefined) return state
    const { [conversationId]: _line, ...rest } = state.byConversation
    // Left and joined again while away (docs/03 section 11, D-205): the person's own plain text that had not gone out stays
    // for them to send again or delete, and is never sent by itself. Without the reply it was written to (the new membership
    // may not see that message) and without anything else of the old membership; one that was on its way is dropped, so
    // its answer is not taken (D-171).
    const kept =
      reason === 'membership'
        ? line
            .filter(
              (entry) =>
                entry.state !== 'sending' &&
                (entry.attachments?.length ?? 0) === 0 &&
                entry.body.trim() !== '',
            )
            .map(
              (entry): PendingMessage => ({
                ...entry,
                state: 'failed',
                error: 'MEMBERSHIP_CHANGED',
                replyToId: null,
                quote: null,
              }),
            )
        : []
    return { byConversation: kept.length > 0 ? { ...rest, [conversationId]: kept } : rest }
  }),
)
