/**
 * Messages the person has sent that the server has not answered yet (docs/01 section 4.5, D-154). A message shows up at
 * once as "sending"; those of one conversation go out one at a time, in the order they were typed; a failure marks that one
 * as failed (retry sends it again with the *same* `clientId`, which the server answers idempotently, so a retry can never
 * make a duplicate) and the ones behind it go on. Kept in memory only (M6 adds offline storage), cleared with the account and
 * with a conversation's line when the membership the messages were written under ends (D-171); what a request that was
 * still out brings back after that is dropped.
 */
import type { MessageEnvelope, ReplyTo, SendMessageRequest } from '@chatapp/contracts'
import { create } from 'zustand'
import { ApiError } from '../api.ts'
import { registerConversationReset, registerStoreReset } from './stores.ts'
import type { RequestTicket } from './types.ts'

export type PendingState = 'queued' | 'sending' | 'failed'

export type PendingMessage = {
  clientId: string
  conversationId: string
  /** The membership the message was written under: after leaving and re-joining it is not sent on its own. */
  membershipId: string
  body: string
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
  /** The server accepted a message: it goes into the cache like every other answer (unless the ticket is out of date). */
  onSent: (envelope: MessageEnvelope, ticket: RequestTicket) => void
  /** An error that may mean the conversation is gone for me; true when it was handled as that (then nothing is shown). */
  onAccessError: (conversationId: string, error: unknown, ticket: RequestTicket) => boolean
  /** The membership I hold in the conversation now. */
  membershipOf: (conversationId: string) => string | undefined
  now: () => number
  newId: () => string
}

export type EnqueueInput = {
  conversationId: string
  membershipId: string
  body: string
  replyToId: string | null
  quote: PendingMessage['quote']
}

export class Outbox {
  readonly #deps: OutboxDeps

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
    const pending: PendingMessage = {
      clientId: this.#deps.newId(),
      conversationId: input.conversationId,
      membershipId: input.membershipId,
      body: input.body,
      replyToId: input.replyToId,
      quote: input.quote,
      createdAt: new Date(this.#deps.now()).toISOString(),
      state: 'queued',
      error: null,
    }
    this.#update(input.conversationId, (list) => [...list, pending])
    void this.#pump(input.conversationId)
    return pending
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
        body: next.body,
        ...(next.replyToId === null ? {} : { replyToId: next.replyToId }),
      })
      if (!this.#inFlight(conversationId, next.clientId)) return
      // The answer goes into the cache first, then the pending copy goes: both land in the same render.
      this.#deps.onSent(envelope, ticket)
      this.#update(conversationId, (rows) =>
        rows.filter((entry) => entry.clientId !== next.clientId),
      )
    } catch (error) {
      if (!this.#inFlight(conversationId, next.clientId)) return
      if (this.#deps.onAccessError(conversationId, error, ticket)) {
        this.clearConversation(conversationId)
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
}

// Nothing of a conversation survives the account: the engine empties the registered stores when it stops, and the
// conversation's own line when its membership ends.
registerStoreReset(() => useOutbox.setState({ byConversation: {} }))
registerConversationReset((conversationId) =>
  useOutbox.setState((state) => {
    if (!(conversationId in state.byConversation)) return state
    const { [conversationId]: _line, ...rest } = state.byConversation
    return { byConversation: rest }
  }),
)
