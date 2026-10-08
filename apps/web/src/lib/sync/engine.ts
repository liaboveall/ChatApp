/**
 * The sync engine (docs/05 section 4.5, docs/03 section 11, D-150). It decides what to read from the server and when;
 * TanStack Query only stores what it merges. Hints from the WebSocket raise what the client has *heard of* (`observed`);
 * only replaying the change log raises what it has *applied* (`synced`), through pages with a fixed upper bound, so a
 * lost hint is repaired by the next reconciliation and a repeated one does nothing twice. Every answer is checked
 * against the scope and the conversation generation it was asked under before it is merged, and merged by entity version.
 *
 * Nothing here imports React or touches the DOM, so the whole thing runs under a fake transport in unit tests.
 */
import {
  type AgentDelta,
  type Conversation,
  LIMITS,
  type Me,
  type Message,
  type MessageEnvelope,
  type MessagesResponse,
  type UserChangesResponse,
  type UserSummary,
  type WsServerMessage,
} from '@chatapp/contracts'
import type { QueryClient } from '@tanstack/react-query'
import { ApiError } from '../api.ts'
import { writeMe, writeMeAnswer } from '../queries.ts'
import { mergeAgentDelta } from './agent-stream.ts'
import { RequestBudget } from './budget.ts'
import { isScopeKey, syncKeys } from './keys.ts'
import {
  applyRemoval,
  emptyIndex,
  forgetInIndex,
  mergeConversation,
  mergeUsers,
  previewOf,
  raiseCounters,
} from './merge.ts'
import { syncUi, useSyncUi } from './state.ts'
import type { SyncTransport } from './transport.ts'
import type {
  ConversationEffect,
  ConversationIndex,
  RequestTicket,
  SyncScope,
  TimelineWindow,
  UsersByid,
} from './types.ts'
import {
  appendPage,
  hideInWindow,
  mergeChanges,
  newestOf,
  prependPage,
  trimNewest,
  trimOldest,
  WINDOW_MAX,
  windowFromPage,
} from './window.ts'

export type ForgetReason = 'left' | 'removed' | 'no-access' | 'snapshot'

export type EngineDeps = {
  queryClient: QueryClient
  transport: SyncTransport
  now?: () => number
  random?: () => number
  budget?: RequestBudget
  /** The page is in front: reconciliation only runs then. */
  isVisible?: () => boolean
  isOnline?: () => boolean
  /** A conversation left the cache for good: the screen navigates away and says why; other stores drop their copies. */
  onForgotten?: (conversationId: string, reason: ForgetReason) => void
  /**
   * Whatever the person wrote or chose for a conversation under a membership that has ended (an unsent message, a draft, a
   * reply or an edit in progress) must go: called when the conversation is forgotten and whenever its membership turns into
   * another one by any route (D-171, SEC-34). Not called for the end of the scope: `onStop` empties everything then.
   */
  onConversationReset?: (conversationId: string) => void
  /** The engine stopped (session end, scope switch): stores outside it (drafts, outbox, typing, presence) clear too. */
  onStop?: () => void
}

// Spacing and sizes (docs/05 section 4.5, D-150, the request budget of D-150).
/** The open conversation is read again 50 ms after a hint (batching); the others at most every 2 seconds. */
const OPEN_GAP_MS = 50
const BACKGROUND_GAP_MS = 2000
const USER_GAP_MS = 500
const REFETCH_BATCH_MS = 50
const REFETCH_GAP_MS = 2000
const READ_GAP_MS = 1000
/** A client further behind than this many conversations reads the whole list once instead of one by one. */
const LAGGING_LIST_AT = 10
const RECONCILE_MS = 30_000
const BACKOFF_FIRST_MS = 1000
const BACKOFF_MAX_MS = 30_000
const MAX_PULLS = 2
const WINDOWS_KEPT = 8
const FIRST_PAGE = LIMITS.messagePageDefault
const MORE_PAGE = LIMITS.messagePageMax
const TRIM_DELAY_MS = 40

type ConvSync = {
  readonly id: string
  /** Bumped whenever what is cached for the conversation is replaced or dropped: answers from before are discarded. */
  generation: number
  membershipId: string | null
  /** The highest change sequence heard of (hints, heads, write answers). Never assigned to `synced`. */
  observed: number
  /** When `observed` last went up: a round that started later has seen everything that was hinted before. */
  observedAt: number
  /** The log position replayed so far. null: there is no window, so there is nothing to replay. */
  synced: number | null
  pulling: boolean
  /** Identifies the round in flight, so a round that was replaced under it cannot clear the flag of its successor. */
  pullToken: symbol | undefined
  failures: number
  retryAt: number
  lastStart: number
  timer: ReturnType<typeof setTimeout> | undefined
  controller: AbortController
  olderLoading: boolean
  newerLoading: boolean
  /** Counts the requests that will *replace* the window: only the newest one may install its page (D-171). */
  turn: number
  /** Counts the times `synced` was moved back (D-171): a round of catch-up that started before is discarded. */
  epoch: number
}

type UserSync = {
  observed: number
  observedAt: number
  synced: number | null
  pulling: boolean
  failures: number
  retryAt: number
  lastStart: number
  timer: ReturnType<typeof setTimeout> | undefined
}

type ReadState = {
  wanted: number
  inFlight: boolean
  lastStart: number
  timer: ReturnType<typeof setTimeout> | undefined
}

const newUser = (): UserSync => ({
  observed: 0,
  observedAt: 0,
  synced: null,
  pulling: false,
  failures: 0,
  retryAt: 0,
  lastStart: 0,
  timer: undefined,
})

/** What `setQueryDefaults` applies to every key of the sync layer: stored data, never fetched or dropped by Query. */
export const SYNC_QUERY_DEFAULTS = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  retry: false,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  structuralSharing: false,
} as const

const backoff = (failures: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1))

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === 'AbortError'

export class SyncEngine {
  readonly #qc: QueryClient
  readonly #transport: SyncTransport
  readonly #now: () => number
  readonly #random: () => number
  readonly #budget: RequestBudget
  readonly #visible: () => boolean
  readonly #online: () => boolean
  readonly #onForgotten: NonNullable<EngineDeps['onForgotten']>
  readonly #onConversationReset: NonNullable<EngineDeps['onConversationReset']>
  readonly #onStop: NonNullable<EngineDeps['onStop']>

  #scope: SyncScope | null = null
  #scopes = 0
  /**
   * Which sign-in the tab is in (D-174): it moves on when the session ends or another person signs in, and stays when the
   * same person's login generation changes under a live session (a password change). `#scopes` counts the second kind too.
   */
  #session = 0
  #controller = new AbortController()
  readonly #convs = new Map<string, ConvSync>()
  #user: UserSync = newUser()
  /** Conversations with a window, least recently opened first. */
  readonly #windows: string[] = []
  #open: string | null = null
  /** Messages I deleted for myself that arrived while the conversation had no window to apply them to. */
  readonly #hiddenLater = new Map<string, Set<string>>()
  readonly #reads = new Map<string, ReadState>()
  #pulls = 0
  readonly #pullQueue: string[] = []
  readonly #refetchQueue = new Set<string>()
  readonly #refetchLast = new Map<string, number>()
  #refetchTimer: ReturnType<typeof setTimeout> | undefined
  #reconcileTimer: ReturnType<typeof setTimeout> | undefined
  #reconciling = false
  #ready = false
  #indexFailures = 0
  #indexTimer: ReturnType<typeof setTimeout> | undefined
  /** Conversations a hint named before the index finished loading: read again once it did. */
  readonly #earlyHints = new Set<string>()

  constructor(deps: EngineDeps) {
    this.#qc = deps.queryClient
    this.#transport = deps.transport
    this.#now = deps.now ?? Date.now
    this.#random = deps.random ?? Math.random
    this.#budget = deps.budget ?? new RequestBudget({ now: this.#now })
    this.#visible = deps.isVisible ?? (() => document.visibilityState === 'visible')
    this.#online = deps.isOnline ?? (() => navigator.onLine)
    this.#onForgotten = deps.onForgotten ?? (() => undefined)
    this.#onConversationReset = deps.onConversationReset ?? (() => undefined)
    this.#onStop = deps.onStop ?? (() => undefined)
    this.#qc.setQueryDefaults(['u'], SYNC_QUERY_DEFAULTS)
  }

  get scope(): SyncScope | null {
    return this.#scope
  }

  // ───────── Lifecycle ─────────

  /** Starts serving this account: loads the conversation list, then keeps everything in step. Safe to call again. */
  async start(me: Me): Promise<void> {
    const current = this.#scope
    if (
      current !== null &&
      current.userId === me.id &&
      current.authEpoch === me.authEpoch &&
      current.restoreEpoch === me.restoreEpoch
    ) {
      return
    }
    if (current !== null) {
      this.#teardown(current)
      // Another account in the same page without a stop in between: nothing of the first one's may be left for the second.
      if (current.userId !== me.id) {
        this.#session += 1
        this.#onStop()
      }
    }
    this.#scopes += 1
    const scope: SyncScope = {
      userId: me.id,
      authEpoch: me.authEpoch,
      restoreEpoch: me.restoreEpoch,
      generation: this.#scopes,
    }
    this.#scope = scope
    this.#controller = new AbortController()
    this.#ready = false
    syncUi.reset()
    useSyncUi.setState({ scope })
    await this.#loadIndex(scope)
  }

  /**
   * The login generation changed under a live session (a password change on this device): the old generation's keys
   * and stored state go, and everything is read again under the new scope; the person stays signed in (D-150).
   */
  async switchScope(me: Me): Promise<void> {
    const current = this.#scope
    if (current === null) return await this.start(me)
    if (
      current.userId === me.id &&
      current.authEpoch === me.authEpoch &&
      current.restoreEpoch === me.restoreEpoch
    ) {
      return
    }
    await this.start(me)
  }

  /** The session ended or the account changed: stop everything and forget what this scope cached. */
  stop(): void {
    const scope = this.#scope
    if (scope !== null) this.#teardown(scope)
    this.#scope = null
    this.#session += 1
    syncUi.reset()
    this.#onStop()
  }

  #teardown(scope: SyncScope): void {
    this.#controller.abort()
    for (const cs of this.#convs.values()) this.#clearConv(cs)
    this.#convs.clear()
    this.#clearTimer(this.#user.timer)
    this.#user = newUser()
    this.#windows.length = 0
    this.#open = null
    this.#hiddenLater.clear()
    for (const state of this.#reads.values()) this.#clearTimer(state.timer)
    this.#reads.clear()
    this.#pullQueue.length = 0
    this.#pulls = 0
    this.#refetchQueue.clear()
    this.#refetchLast.clear()
    this.#clearTimer(this.#refetchTimer)
    this.#refetchTimer = undefined
    this.#clearTimer(this.#reconcileTimer)
    this.#reconcileTimer = undefined
    this.#reconciling = false
    this.#ready = false
    this.#indexFailures = 0
    this.#clearTimer(this.#indexTimer)
    this.#indexTimer = undefined
    this.#earlyHints.clear()
    this.#scope = null
    void this.#qc.cancelQueries({ predicate: (query) => isScopeKey(query.queryKey, scope) })
    this.#qc.removeQueries({ predicate: (query) => isScopeKey(query.queryKey, scope) })
  }

  #clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (timer !== undefined) clearTimeout(timer)
  }

  #clearConv(cs: ConvSync): void {
    cs.generation += 1
    cs.controller.abort()
    this.#clearTimer(cs.timer)
    cs.timer = undefined
  }

  /** True while `scope` is still the scope the engine serves. */
  #live(scope: SyncScope): boolean {
    return this.#scope === scope
  }

  /** Records that a change up to `seq` exists; the time lets a later round tell a real change from a stale claim. */
  #observe(cs: ConvSync, seq: number): void {
    if (seq <= cs.observed) return
    cs.observed = seq
    cs.observedAt = this.#now()
  }

  #observeUser(seq: number): void {
    if (seq <= this.#user.observed) return
    this.#user.observed = seq
    this.#user.observedAt = this.#now()
  }

  #conv(id: string): ConvSync {
    let cs = this.#convs.get(id)
    if (cs === undefined) {
      cs = {
        id,
        generation: 0,
        membershipId: null,
        observed: 0,
        observedAt: 0,
        synced: null,
        pulling: false,
        pullToken: undefined,
        failures: 0,
        retryAt: 0,
        lastStart: 0,
        timer: undefined,
        controller: new AbortController(),
        olderLoading: false,
        newerLoading: false,
        turn: 0,
        epoch: 0,
      }
      this.#convs.set(id, cs)
    }
    return cs
  }

  // ───────── The cache ─────────

  #index(scope: SyncScope): ConversationIndex {
    return this.#qc.getQueryData<ConversationIndex>(syncKeys.conversations(scope)) ?? emptyIndex()
  }

  #writeIndex(scope: SyncScope, next: ConversationIndex): void {
    const key = syncKeys.conversations(scope)
    if (next !== this.#qc.getQueryData<ConversationIndex>(key)) this.#qc.setQueryData(key, next)
  }

  #mergeUsers(
    scope: SyncScope,
    incoming: Iterable<UserSummary> | Record<string, UserSummary>,
  ): void {
    const key = syncKeys.users(scope)
    const current = this.#qc.getQueryData<UsersByid>(key)
    const next = mergeUsers(current ?? {}, incoming)
    if (next !== current) this.#qc.setQueryData(key, next)
  }

  #window(scope: SyncScope, id: string, membershipId: string): TimelineWindow | undefined {
    return this.#qc.getQueryData<TimelineWindow>(syncKeys.timeline(scope, id, membershipId))
  }

  #writeWindow(scope: SyncScope, window: TimelineWindow): void {
    this.#qc.setQueryData(
      syncKeys.timeline(scope, window.conversationId, window.membershipId),
      window,
    )
  }

  /** The window of the conversation as it stands now, or undefined when there is none (or no relation). */
  windowOf(id: string): TimelineWindow | undefined {
    const scope = this.#scope
    if (scope === null) return undefined
    const membershipId = this.#index(scope).byId[id]?.me?.membershipId
    return membershipId === undefined ? undefined : this.#window(scope, id, membershipId)
  }

  #dropWindow(scope: SyncScope, id: string, membershipId: string): void {
    this.#qc.removeQueries({ queryKey: syncKeys.timeline(scope, id, membershipId), exact: true })
  }

  // ───────── Folding answers into the cache ─────────

  #mergeConversation(scope: SyncScope, incoming: Conversation): void {
    const { index, effects } = mergeConversation(this.#index(scope), incoming)
    this.#writeIndex(scope, index)
    if (incoming.dmPeer !== null) this.#mergeUsers(scope, [incoming.dmPeer])
    for (const effect of effects) this.#carryOut(scope, effect)
    // The server has caught up with what this client already counted as read: the local claim is no longer needed.
    const claimed = useSyncUi.getState().pendingRead[incoming.id]
    const confirmed = index.byId[incoming.id]?.me?.lastReadSeq
    if (claimed !== undefined && confirmed !== undefined && confirmed >= claimed) {
      syncUi.setPendingRead(incoming.id, undefined)
    }
  }

  #carryOut(scope: SyncScope, effect: ConversationEffect): void {
    if (effect.type === 'membership-changed') {
      this.#forgetMembership(scope, effect.conversationId, effect.from, effect.to)
    } else {
      this.#refetchSoon(effect.conversationId)
    }
  }

  // ───────── Answers to requests that screens made (D-171) ─────────

  /**
   * Taken by a screen when it sends a request about the account (no id) or about one conversation: what the answer is
   * checked against when it comes back. A request made while nobody is signed in gets a ticket nothing accepts.
   */
  ticket(conversationId: string | null = null): RequestTicket {
    const scope = this.#scope
    const session = this.#session
    if (scope === null || conversationId === null) {
      return { scope, session, conversationId, membershipId: null, watermark: 0 }
    }
    return {
      scope,
      session,
      conversationId,
      membershipId: this.#index(scope).byId[conversationId]?.me?.membershipId ?? null,
      watermark: this.#headOf(scope, conversationId),
    }
  }

  /**
   * Whether what follows from the answer to a request (a jump to the conversation it made, a message saying what was done) is
   * still for the person in front of the screen (D-174): the same sign-in, and, for a request about one conversation, the same
   * membership. Looser than what the cache accepts (`#answerable` also wants the same login generation, which a password
   * change moves on): the person who asked still wants to see that it worked, and the cache catches up by itself. Another
   * person, the same person after signing out and in again, or a membership that ended and began again are not the ones that
   * asked: nothing may follow from an answer, nor from a failure, that is not for them.
   */
  isCurrent(ticket: RequestTicket): boolean {
    if (ticket.session !== this.#session) return false
    const scope = this.#scope
    // A request made where no engine runs (a page outside the shell, the invitation link) has no scope to compare: it is for
    // whoever is there while that is still so, and it is not once the engine starts or the session ends.
    if (ticket.scope === null) return scope === null
    if (scope === null) return false
    if (ticket.conversationId === null) return true
    const held = this.#index(scope).byId[ticket.conversationId]?.me?.membershipId ?? null
    return held === ticket.membershipId
  }

  /** The newest change of a conversation that the client already knows of: a read made now is at least as new as this. */
  #headOf(scope: SyncScope, id: string): number {
    return Math.max(
      this.#convs.get(id)?.synced ?? 0,
      this.#index(scope).byId[id]?.lastChangeSeq ?? 0,
    )
  }

  /**
   * The scope an answer to a request may still be merged into, or null when the request belongs to something that is gone:
   * the scope was replaced (another account, a new login generation, a stop and a start), or the conversation is held
   * under another membership now (left, removed and joined again). Such an answer, and such an error, is dropped.
   */
  #answerable(ticket: RequestTicket): SyncScope | null {
    const scope = this.#scope
    if (scope === null || ticket.scope !== scope) return null
    if (ticket.conversationId === null) return scope
    const held = this.#index(scope).byId[ticket.conversationId]?.me?.membershipId ?? null
    return held === ticket.membershipId ? scope : null
  }

  /** Public: an answer about a conversation that the screens obtained themselves (a write, a read, a profile). */
  ingestConversation(conversation: Conversation, ticket: RequestTicket): void {
    const scope = this.#answerable(ticket)
    if (scope !== null) this.#mergeConversation(scope, conversation)
  }

  /**
   * Public: the answer to a write on a message (send, edit, recall): merged by version like everything else. Returns whether
   * it was taken; an answer to a request made under another scope or membership is not (the message could be one the person
   * in front of the screen may not see).
   */
  ingestMessage(envelope: MessageEnvelope, ticket: RequestTicket): boolean {
    const { message } = envelope
    const scope = this.#answerable(ticket)
    if (
      scope === null ||
      ticket.conversationId !== message.conversationId ||
      ticket.membershipId === null
    ) {
      return false
    }
    this.#mergeUsers(scope, envelope.users)
    const index = this.#index(scope)
    const membershipId = index.byId[message.conversationId]?.me?.membershipId
    if (membershipId === undefined) return false
    const cs = this.#conv(message.conversationId)
    this.#observe(cs, message.changeSeq)
    const window = this.#window(scope, message.conversationId, membershipId)
    if (window !== undefined) {
      const next = mergeChanges(window, [message])
      if (next !== window) this.#writeWindow(scope, next)
      this.#derive(scope, message.conversationId)
      // A reply carries a quote that was true when the server answered; whatever the log said since about the quoted
      // message is replayed onto it, from the position this request was made at.
      const quote = message.replyTo
      if (quote !== null && 'id' in quote) this.#rewind(cs, ticket.watermark)
      this.#schedulePull(cs)
    }
    return true
  }

  ingestAgentDelta(delta: AgentDelta): 'applied' | 'gap' | 'ignore' {
    const scope = this.#scope
    if (!scope) return 'ignore'
    const membership = this.#index(scope).byId[delta.conversationId]?.me
    if (!membership) return 'ignore'
    const win = this.#window(scope, delta.conversationId, membership.membershipId)
    if (!win) return 'ignore'
    const current = win.messages.find((message) => message.id === delta.messageId)
    const next = mergeAgentDelta(current, delta)
    if (typeof next === 'string') return next
    this.#writeWindow(scope, {
      ...win,
      messages: win.messages.map((message) => (message.id === next.id ? next : message)),
    })
    return 'applied'
  }

  /**
   * My own message went out and the server accepted it: it goes into the cache, and the server has moved my read position
   * with it (D-083), so only the local claim is needed to keep it from showing up as unread until my own log delivers the
   * new position. No request.
   */
  messageSent(envelope: MessageEnvelope, ticket: RequestTicket): void {
    if (this.ingestMessage(envelope, ticket)) {
      this.noteSent(envelope.message.conversationId, envelope.message.seq)
    }
  }

  /** Public: people a screen learned of (a member list, a search) go into the dictionary by profile version. */
  ingestUsers(users: Iterable<UserSummary>, ticket: RequestTicket): void {
    const scope = this.#answerable(ticket)
    if (scope !== null) this.#mergeUsers(scope, users)
  }

  /** Whether the dictionary has this person (at any profile version). */
  knowsUser(id: string): boolean {
    const scope = this.#scope
    if (scope === null) return false
    return this.#qc.getQueryData<UsersByid>(syncKeys.users(scope))?.[id] !== undefined
  }

  /** My own account from my own log: merged by version, identity changes replace. */
  #writeMe(me: Me | null): void {
    writeMe(this.#qc, me)
  }

  /**
   * The answer to a write on my own account (a profile edit, the time zone): only ever updates the identity it was made
   * for (D-171), and the people dictionary takes it when the account is still the one the request was made under.
   */
  ingestMe(me: Me, ticket: RequestTicket): void {
    writeMeAnswer(this.#qc, me)
    const scope = this.#answerable(ticket)
    if (scope !== null) this.#mergeUsers(scope, [me])
  }

  /** Raises the counters and the preview of a conversation from its window when that reaches the newest message. */
  #derive(scope: SyncScope, id: string): void {
    const index = this.#index(scope)
    const conversation = index.byId[id]
    const membershipId = conversation?.me?.membershipId
    if (conversation === undefined || membershipId === undefined) return
    const window = this.#window(scope, id, membershipId)
    if (window === undefined || window.hasMoreAfter) return
    const newest = newestOf(window)
    const synced = this.#convs.get(id)?.synced
    if (newest === undefined || synced === null || synced === undefined) return
    this.#writeIndex(
      scope,
      raiseCounters(
        index,
        id,
        { lastSeq: newest.seq, lastChangeSeq: synced, lastMessageAt: newest.createdAt },
        {
          preview: previewOf(newest),
          version: { lastChangeSeq: synced, viewerVersion: conversation.viewerVersion },
        },
      ),
    )
  }

  // ───────── Loading the conversation list ─────────

  async #loadIndex(scope: SyncScope): Promise<void> {
    try {
      const response = await this.#transport.listConversations(this.#controller.signal)
      if (!this.#live(scope)) return
      let index = this.#index(scope)
      const effects: ConversationEffect[] = []
      for (const conversation of response.conversations) {
        const merged = mergeConversation(index, conversation)
        index = merged.index
        effects.push(...merged.effects)
        if (conversation.dmPeer !== null) this.#mergeUsers(scope, [conversation.dmPeer])
      }
      this.#writeIndex(scope, index)
      for (const effect of effects) this.#carryOut(scope, effect)
      this.#user.synced = Math.max(this.#user.synced ?? 0, response.userChangeSeq)
      this.#observeUser(response.userChangeSeq)
      this.#ready = true
      this.#indexFailures = 0
      useSyncUi.setState({ ready: true, loadError: false })
      for (const id of this.#earlyHints) this.#refetchSoon(id)
      this.#earlyHints.clear()
      this.#armReconcile()
      this.#schedulePersonalPull()
    } catch (error) {
      if (!this.#live(scope) || isAbort(error)) return
      this.#handleError(error, null)
      useSyncUi.setState({ loadError: true })
      // Keep trying with a growing pause: the sidebar is useless until this works.
      this.#indexFailures += 1
      this.#indexTimer = setTimeout(
        () => {
          this.#indexTimer = undefined
          if (this.#live(scope) && !this.#ready) void this.#loadIndex(scope)
        },
        Math.max(backoff(this.#indexFailures), this.#budget.pausedUntil - this.#now()),
      )
    }
  }

  /** The list could not be loaded the first time (or the person asked): try again now. */
  async reload(): Promise<void> {
    const scope = this.#scope
    if (scope === null) return
    this.#clearTimer(this.#indexTimer)
    this.#indexTimer = undefined
    useSyncUi.setState({ loadError: false })
    await this.#loadIndex(scope)
  }

  // ───────── Opening a conversation ─────────

  /**
   * Makes the timeline of a conversation available and keeps it current. The newest page is read, or a page around the
   * first unread message when there are many unread ones. The log position it starts from is read *before* the page
   * (anything after it is replayed, anything before it is already in the page), never the other way round.
   */
  async openConversation(id: string, options: { auxiliary?: boolean } = {}): Promise<void> {
    const scope = this.#scope
    if (scope === null) return
    if (!options.auxiliary) this.#open = id
    this.#touch(scope, id)
    syncUi.setTimeline(id, this.windowOf(id) === undefined ? 'loading' : 'ready')
    try {
      let conversation = this.#index(scope).byId[id]
      if (conversation?.me == null) {
        await this.refreshConversation(id)
        if (!this.#live(scope)) return
        conversation = this.#index(scope).byId[id]
      }
      const me = conversation?.me
      if (conversation === undefined || me === null || me === undefined) {
        // Not a member (or gone): there is no timeline to keep, the screen shows what it can of the conversation.
        syncUi.setTimeline(id, undefined)
        return
      }
      const cs = this.#conv(id)
      if (cs.membershipId !== null && cs.membershipId !== me.membershipId) {
        this.#forgetMembership(scope, id, cs.membershipId, me.membershipId)
      }
      cs.membershipId = me.membershipId
      if (useSyncUi.getState().anchors[id] === undefined) {
        syncUi.setAnchor(id, Math.max(me.lastReadSeq, useSyncUi.getState().pendingRead[id] ?? 0))
      }
      if (this.#window(scope, id, me.membershipId) === undefined) {
        await this.#loadFirstWindow(scope, cs, conversation, me.membershipId, me.lastReadSeq)
      } else {
        this.#schedulePull(cs)
      }
      if (this.#live(scope) && this.windowOf(id) !== undefined) syncUi.setTimeline(id, 'ready')
    } catch (error) {
      if (!this.#live(scope) || isAbort(error)) return
      if (this.#handleError(error, id)) return
      // 404 and 403 answer the same for "there is none" and "not yours": the screen words both the same way.
      const gone = error instanceof ApiError && (error.status === 404 || error.status === 403)
      syncUi.setTimeline(id, gone ? 'missing' : 'error')
    }
  }

  /** The person left the conversation's screen: its window stays warm (up to a few), and nothing is open any more. */
  closeConversation(id: string): void {
    if (this.#open === id) this.#open = null
    syncUi.setAnchor(id, undefined)
  }

  /** Back in front with unread messages: the separator moves to where the person stopped reading. */
  refreshAnchor(id: string): void {
    const scope = this.#scope
    const conversation = scope === null ? undefined : this.#index(scope).byId[id]
    const me = conversation?.me
    if (conversation === undefined || me === null || me === undefined) return
    const read = Math.max(me.lastReadSeq, useSyncUi.getState().pendingRead[id] ?? 0)
    if (conversation.lastSeq > read) syncUi.setAnchor(id, read)
  }

  async #loadFirstWindow(
    scope: SyncScope,
    cs: ConvSync,
    conversation: Conversation,
    membershipId: string,
    lastReadSeq: number,
  ): Promise<void> {
    const generation = cs.generation
    const turn = this.#nextTurn(cs)
    // What the page will be at least as new as: read *before* the page, never after (D-150).
    const watermark = this.#headOf(scope, cs.id)
    const stale = (): boolean =>
      !this.#live(scope) || cs.generation !== generation || cs.turn !== turn
    let page = await this.#transport.listMessages(
      cs.id,
      { limit: FIRST_PAGE },
      cs.controller.signal,
    )
    if (stale()) return
    const first = page.messages[0]
    const unreadStart = Math.max(lastReadSeq, useSyncUi.getState().pendingRead[cs.id] ?? 0) + 1
    // Many unread messages: the first unread one lies above the newest page, so read around it instead.
    if (
      page.hasMoreBefore &&
      first !== undefined &&
      first.seq > unreadStart &&
      conversation.lastSeq >= unreadStart
    ) {
      page = await this.#transport.listMessages(
        cs.id,
        { aroundSeq: unreadStart, limit: FIRST_PAGE },
        cs.controller.signal,
      )
      if (stale()) return
    }
    this.#installWindow(scope, cs, membershipId, page, watermark)
  }

  /**
   * A page that replaces the window (the first one, a jump, the way back to the newest) goes in (D-171). The window it
   * replaces keeps what it knew in a newer version (the page was read before that change), and this is a different window
   * now: whatever was asked for the old one is discarded. The page is only as new as the moment it was asked for
   * (`watermark`), so the log position is set to *that*, not left where it was: the log is applied to the page again from
   * there, and by version nothing is done twice. Leaving `synced` at the old, further position would count changes as
   * applied that this page never had.
   */
  #installWindow(
    scope: SyncScope,
    cs: ConvSync,
    membershipId: string,
    page: MessagesResponse,
    watermark: number,
  ): void {
    this.#mergeUsers(scope, page.users)
    const previous = this.#window(scope, cs.id, membershipId)
    const later = this.#hiddenLater.get(cs.id)
    const hidden = { ...(previous?.hidden ?? {}) }
    for (const id of later ?? []) hidden[id] = true
    const window = windowFromPage(cs.id, membershipId, page, {
      hidden,
      gone: previous?.gone ?? {},
      messages: previous?.messages,
      quoted: previous?.quoted,
    })
    this.#hiddenLater.delete(cs.id)
    this.#writeWindow(
      scope,
      previous === undefined ? window : { ...window, revision: previous.revision + 1 },
    )
    cs.generation += 1
    const before = cs.synced
    cs.synced = watermark
    if (before !== null && before > watermark) this.#observe(cs, before)
    this.#derive(scope, cs.id)
    this.#schedulePull(cs)
  }

  /** The number of a request that is about to replace the window: the one asked last is the one that counts (D-171). */
  #nextTurn(cs: ConvSync): number {
    cs.turn += 1
    return cs.turn
  }

  /**
   * Something read at `watermark` has joined the window, but the log was applied further since the request went out: the
   * position goes back to the watermark so that everything after it is applied again (what the read cannot have had: a
   * change to a message that was then outside the window, to a quoted message). A round of catch-up that is running is
   * discarded, its result would move the position forward again over what has to be applied again.
   */
  #rewind(cs: ConvSync, watermark: number): void {
    const synced = cs.synced
    if (synced === null || synced <= watermark) return
    cs.synced = watermark
    cs.epoch += 1
    this.#observe(cs, synced)
    this.#schedulePull(cs)
  }

  /** Reads one conversation again (profile, counters, preview, my relation) and merges it. */
  async refreshConversation(id: string): Promise<void> {
    const scope = this.#scope
    if (scope === null) return
    const asked = this.#index(scope).byId[id]?.me?.membershipId ?? null
    try {
      const conversation = await this.#transport.getConversation(id, this.#controller.signal)
      if (!this.#live(scope)) return
      this.#mergeConversation(scope, conversation)
    } catch (error) {
      if (!this.#live(scope) || isAbort(error)) return
      // Asked under a membership that is not the one held now (left and joined again meanwhile): says nothing about it.
      if ((this.#index(scope).byId[id]?.me?.membershipId ?? null) !== asked) return
      if (!this.#handleError(error, id)) throw error
    }
  }

  // ───────── Moving through a window ─────────

  /** Reads the next older page. Resolves false when there is nothing older (or something is already loading). */
  async loadOlder(id: string): Promise<boolean> {
    const scope = this.#scope
    const state = scope === null ? undefined : this.#state(scope, id)
    if (scope === null || state === undefined || !state.window.hasMoreBefore) return false
    const { cs, window } = state
    if (cs.olderLoading) return false
    const first = window.messages[0]
    cs.olderLoading = true
    const generation = cs.generation
    const watermark = this.#headOf(scope, id)
    try {
      const page = await this.#transport.listMessages(
        id,
        first === undefined ? { limit: MORE_PAGE } : { beforeSeq: first.seq, limit: MORE_PAGE },
        cs.controller.signal,
      )
      if (!this.#live(scope) || cs.generation !== generation) return false
      this.#mergeUsers(scope, page.users)
      const current = this.#window(scope, id, window.membershipId)
      if (current === undefined) return false
      this.#writeWindow(scope, prependPage(current, page))
      this.#rewind(cs, watermark)
      this.#trimLater(scope, cs, window.membershipId, 'newest')
      return true
    } catch (error) {
      if (!this.#live(scope) || cs.generation !== generation || isAbort(error)) return false
      if (this.#handleError(error, id)) return false
      throw error
    } finally {
      cs.olderLoading = false
    }
  }

  /** Reads the next newer page of a window that does not reach the newest message yet. */
  async loadNewer(id: string): Promise<boolean> {
    const scope = this.#scope
    const state = scope === null ? undefined : this.#state(scope, id)
    if (scope === null || state === undefined || !state.window.hasMoreAfter) return false
    const { cs, window } = state
    if (cs.newerLoading) return false
    const last = window.messages[window.messages.length - 1]
    cs.newerLoading = true
    const generation = cs.generation
    const watermark = this.#headOf(scope, id)
    try {
      const page = await this.#transport.listMessages(
        id,
        { afterSeq: last?.seq ?? 0, limit: MORE_PAGE },
        cs.controller.signal,
      )
      if (!this.#live(scope) || cs.generation !== generation) return false
      this.#mergeUsers(scope, page.users)
      const current = this.#window(scope, id, window.membershipId)
      if (current === undefined) return false
      this.#writeWindow(scope, appendPage(current, page))
      this.#rewind(cs, watermark)
      this.#derive(scope, id)
      this.#trimLater(scope, cs, window.membershipId, 'oldest')
      return true
    } catch (error) {
      if (!this.#live(scope) || cs.generation !== generation || isAbort(error)) return false
      if (this.#handleError(error, id)) return false
      throw error
    } finally {
      cs.newerLoading = false
    }
  }

  /**
   * Makes a message the middle of the window: where it is already, nothing is read; otherwise a page around it replaces
   * the window. 'unavailable': the answer does not contain it (not visible, hidden). 'superseded': the person asked for
   * something else after this (another jump, the way back to the newest) and that one counts, so nothing was installed.
   */
  async jumpTo(
    id: string,
    seq: number,
  ): Promise<'in-window' | 'loaded' | 'unavailable' | 'superseded'> {
    const scope = this.#scope
    const state = scope === null ? undefined : this.#state(scope, id)
    if (scope === null || state === undefined) return 'unavailable'
    const { cs, window } = state
    if (window.messages.some((message) => message.seq === seq)) return 'in-window'
    const generation = cs.generation
    const turn = this.#nextTurn(cs)
    const watermark = this.#headOf(scope, id)
    let page: MessagesResponse
    try {
      page = await this.#transport.listMessages(
        id,
        { aroundSeq: seq, limit: FIRST_PAGE },
        cs.controller.signal,
      )
    } catch (error) {
      if (!this.#live(scope) || cs.generation !== generation || isAbort(error)) return 'unavailable'
      if (this.#handleError(error, id)) return 'unavailable'
      throw error
    }
    if (!this.#live(scope)) return 'unavailable'
    if (cs.turn !== turn) return 'superseded'
    if (cs.generation !== generation) return 'unavailable'
    if (!page.messages.some((message) => message.seq === seq)) return 'unavailable'
    this.#installWindow(scope, cs, window.membershipId, page, watermark)
    return 'loaded'
  }

  /** The window reaches the newest message again: where it does already nothing is read, otherwise the newest page is. */
  async backToLatest(id: string): Promise<void> {
    const scope = this.#scope
    const state = scope === null ? undefined : this.#state(scope, id)
    if (scope === null || state === undefined || !state.window.hasMoreAfter) return
    const { cs, window } = state
    const generation = cs.generation
    const turn = this.#nextTurn(cs)
    const watermark = this.#headOf(scope, id)
    let page: MessagesResponse
    try {
      page = await this.#transport.listMessages(id, { limit: FIRST_PAGE }, cs.controller.signal)
    } catch (error) {
      if (!this.#live(scope) || cs.generation !== generation || isAbort(error)) return
      if (this.#handleError(error, id)) return
      throw error
    }
    if (!this.#live(scope) || cs.turn !== turn || cs.generation !== generation) return
    this.#installWindow(scope, cs, window.membershipId, page, watermark)
  }

  #state(scope: SyncScope, id: string): { cs: ConvSync; window: TimelineWindow } | undefined {
    const membershipId = this.#index(scope).byId[id]?.me?.membershipId
    if (membershipId === undefined) return undefined
    const window = this.#window(scope, id, membershipId)
    return window === undefined ? undefined : { cs: this.#conv(id), window }
  }

  /**
   * A window that outgrew its size is cut from the far end in a commit of its own, later than the one that loaded the
   * page: the list may only be told "items were added at the top" in the commit that did it (D-151).
   */
  #trimLater(scope: SyncScope, cs: ConvSync, membershipId: string, end: 'newest' | 'oldest'): void {
    const window = this.#window(scope, cs.id, membershipId)
    if (window === undefined || window.messages.length <= WINDOW_MAX) return
    const generation = cs.generation
    setTimeout(() => {
      if (!this.#live(scope) || cs.generation !== generation) return
      const current = this.#window(scope, cs.id, membershipId)
      if (current === undefined) return
      const next = end === 'newest' ? trimNewest(current) : trimOldest(current)
      if (next !== current) this.#writeWindow(scope, next)
    }, TRIM_DELAY_MS)
  }

  #touch(scope: SyncScope, id: string): void {
    const at = this.#windows.indexOf(id)
    if (at !== -1) this.#windows.splice(at, 1)
    this.#windows.push(id)
    while (this.#windows.length > WINDOWS_KEPT) {
      const victim = this.#windows.find((candidate) => candidate !== this.#open)
      if (victim === undefined) break
      this.#windows.splice(this.#windows.indexOf(victim), 1)
      this.#evict(scope, victim)
    }
  }

  /** A window pushed out of the small LRU: dropped; what the client heard of stays, what it applied is no longer true. */
  #evict(scope: SyncScope, id: string): void {
    const cs = this.#convs.get(id)
    const membershipId = this.#index(scope).byId[id]?.me?.membershipId
    if (membershipId !== undefined) this.#dropWindow(scope, id, membershipId)
    if (cs !== undefined) {
      this.#clearConv(cs)
      cs.controller = new AbortController()
      cs.synced = null
      cs.pulling = false
      cs.pullToken = undefined
    }
    syncUi.setTimeline(id, undefined)
  }

  // ───────── Replaying a conversation's change log ─────────

  /** Queues a round of catch-up for a conversation that has something it has not applied yet. */
  #schedulePull(cs: ConvSync): void {
    const scope = this.#scope
    if (scope === null || !this.#ready || cs.synced === null) return
    // A conversation that was forgotten while its object was still around must not start anything.
    if (this.#convs.get(cs.id) !== cs) return
    // A round in flight re-checks when it ends; a hint that arrives meanwhile has raised `observed` already.
    if (cs.pulling) return
    if (cs.observed <= cs.synced) return
    if (cs.timer !== undefined) return
    const now = this.#now()
    const gap = this.#open === cs.id ? OPEN_GAP_MS : BACKGROUND_GAP_MS
    const wait = Math.max(cs.lastStart + gap - now, cs.retryAt - now, 0)
    if (wait > 0) {
      this.#arm(cs, wait)
      return
    }
    if (!this.#online()) return
    if (this.#pulls >= MAX_PULLS) {
      if (!this.#pullQueue.includes(cs.id)) this.#pullQueue.push(cs.id)
      return
    }
    const budgetWait = this.#budget.take()
    if (budgetWait > 0) {
      this.#arm(cs, budgetWait)
      return
    }
    void this.#pull(scope, cs)
  }

  #arm(cs: ConvSync, ms: number): void {
    cs.timer = setTimeout(() => {
      cs.timer = undefined
      this.#schedulePull(cs)
    }, ms)
  }

  async #pull(scope: SyncScope, cs: ConvSync): Promise<void> {
    const token = Symbol('pull')
    cs.pulling = true
    cs.pullToken = token
    const startedAt = this.#now()
    cs.lastStart = startedAt
    this.#pulls += 1
    const generation = cs.generation
    const epoch = cs.epoch
    const signal = cs.controller.signal
    try {
      let response = await this.#transport.conversationChanges(
        cs.id,
        { after: cs.synced ?? 0, limit: LIMITS.changesPageMax },
        signal,
      )
      for (;;) {
        if (!this.#live(scope) || cs.generation !== generation || cs.epoch !== epoch) return
        if (response.resetRequired || response.membershipId !== cs.membershipId) {
          this.#applyReset(scope, cs, response)
          break
        }
        this.#applyChangesPage(scope, cs, response)
        if (response.nextCursor === null) break
        response = await this.#transport.conversationChanges(
          cs.id,
          { cursor: response.nextCursor },
          signal,
        )
      }
      cs.failures = 0
      syncUi.setFailures(cs.id, 0)
      // A round that started after the last hint has seen everything hinted: a claim beyond the log is not a change.
      if (cs.synced !== null && cs.observedAt <= startedAt && cs.observed > cs.synced) {
        cs.observed = cs.synced
      }
    } catch (error) {
      if (!this.#live(scope) || cs.generation !== generation || cs.epoch !== epoch) return
      if (isAbort(error)) return
      this.#pullFailed(cs, error)
    } finally {
      if (cs.pullToken === token) {
        cs.pulling = false
        cs.pullToken = undefined
      }
      this.#pulls = Math.max(0, this.#pulls - 1)
      this.#runPullQueue()
      if (this.#live(scope)) this.#schedulePull(cs)
    }
  }

  #applyChangesPage(
    scope: SyncScope,
    cs: ConvSync,
    page: {
      items: Message[]
      tombstones: Array<{ id: string; changeSeq: number }>
      users: Record<string, UserSummary>
      scannedThrough: number
      through: number
      nextCursor: string | null
    },
  ): void {
    this.#mergeUsers(scope, page.users)
    const membershipId = cs.membershipId
    const window = membershipId === null ? undefined : this.#window(scope, cs.id, membershipId)
    if (membershipId !== null && window !== undefined) {
      const next = mergeChanges(window, page.items, page.tombstones)
      if (next !== window) this.#writeWindow(scope, next)
      // A new message beyond an end that has more: the window cannot show it, but the conversation list should know.
      const range = window.messages[window.messages.length - 1]
      if (
        window.hasMoreAfter &&
        range !== undefined &&
        page.items.some((item) => item.seq > range.seq)
      ) {
        this.#refetchSoon(cs.id)
      }
    }
    cs.synced = Math.max(cs.synced ?? 0, page.scannedThrough)
    if (page.nextCursor === null) cs.synced = Math.max(cs.synced, page.through)
    this.#derive(scope, cs.id)
  }

  /** The log cannot be replayed: start over from the consistent snapshot the answer carries (docs/05 section 4.5). */
  #applyReset(
    scope: SyncScope,
    cs: ConvSync,
    response: {
      baseline: {
        conversation: Conversation
        messages: Message[]
        users: Record<string, UserSummary>
        hasMoreBefore: boolean
        baselineChangeSeq: number
        baselineUserSeq: number
      } | null
      membershipId: string
    },
  ): void {
    const baseline = response.baseline
    const previousMembership = cs.membershipId
    if (baseline === null) {
      // A different membership without a snapshot: read the conversation again and load the window from nothing.
      if (previousMembership !== null)
        this.#forgetMembership(scope, cs.id, previousMembership, response.membershipId)
      cs.membershipId = response.membershipId
      this.#refetchSoon(cs.id)
      return
    }
    this.#mergeUsers(scope, baseline.users)
    this.#mergeConversation(scope, baseline.conversation)
    const membershipId = baseline.conversation.me?.membershipId ?? response.membershipId
    if (previousMembership !== null && previousMembership !== membershipId) {
      this.#forgetMembership(scope, cs.id, previousMembership, membershipId)
    }
    cs.generation += 1
    cs.membershipId = membershipId
    const window = windowFromPage(cs.id, membershipId, {
      messages: baseline.messages,
      hasMoreBefore: baseline.hasMoreBefore,
      hasMoreAfter: false,
    })
    this.#writeWindow(scope, window)
    cs.synced = baseline.baselineChangeSeq
    // The snapshot is the server's truth: a client that was ahead of it (a restored backup) must not chase the old height.
    cs.observed = baseline.baselineChangeSeq
    cs.observedAt = this.#now()
    this.#observeUser(baseline.baselineUserSeq)
    this.#derive(scope, cs.id)
    this.#schedulePersonalPull()
  }

  #pullFailed(cs: ConvSync, error: unknown): void {
    if (this.#handleError(error, cs.id)) return
    cs.failures += 1
    cs.retryAt = Math.max(cs.retryAt, this.#now() + backoff(cs.failures))
    syncUi.setFailures(cs.id, cs.failures)
  }

  #runPullQueue(): void {
    while (this.#pulls < MAX_PULLS) {
      const id = this.#pullQueue.shift()
      if (id === undefined) return
      const cs = this.#convs.get(id)
      if (cs !== undefined) this.#schedulePull(cs)
    }
  }

  // ───────── Errors ─────────

  /**
   * For code that reads or writes a conversation by itself (sending a message, a member list): when the error means I
   * have no access any more, the conversation is forgotten like any other way of losing it, and this returns true so the
   * caller shows nothing of its own. Any other error is the caller's to word.
   */
  handleAccessError(conversationId: string, error: unknown, ticket: RequestTicket): boolean {
    // The failure of a request made for something that is gone says nothing about what is here now, and nothing is shown.
    if (this.#answerable(ticket) === null || ticket.conversationId !== conversationId) return true
    return this.#handleError(error, conversationId)
  }

  /** I deleted a message for myself (the write was accepted): it leaves the window now, my other devices learn from my log. */
  applyHidden(conversationId: string, messageId: string, ticket: RequestTicket): void {
    const scope = this.#answerable(ticket)
    if (scope !== null && ticket.conversationId === conversationId) {
      this.#hideMessage(scope, conversationId, messageId)
    }
  }

  /**
   * I left the conversation (the server accepted it): it leaves the cache now. Not when the answer is late for it, as when
   * another account is signed in by now and holds that conversation, or I joined again meanwhile.
   */
  leftConversation(conversationId: string, ticket: RequestTicket): void {
    if (this.#answerable(ticket) !== null && ticket.conversationId === conversationId) {
      this.forgetConversation(conversationId, 'left')
    }
  }

  /** The membership I hold in a conversation now, if I am a member. */
  membershipOf(conversationId: string): string | undefined {
    const scope = this.#scope
    return scope === null ? undefined : this.#index(scope).byId[conversationId]?.me?.membershipId
  }

  /**
   * What a failed read means. Returns true when the conversation was forgotten because of it. Losing access is only
   * 404, or 403 for "not a member": any other 403 (admin only, silenced, window expired) concerns one action.
   */
  #handleError(error: unknown, conversationId: string | null): boolean {
    if (!(error instanceof ApiError)) return false
    const scope = this.#scope
    if (
      conversationId !== null &&
      scope !== null &&
      (error.status === 404 || (error.status === 403 && error.reason === 'not_member'))
    ) {
      if (this.#index(scope).byId[conversationId]?.me != null) {
        this.forgetConversation(conversationId, 'no-access')
        // The removal tombstone is in my own log: read it so the index learns why, whatever `observed` says.
        this.#schedulePersonalPull(true)
        return true
      }
      return false
    }
    if (error.status === 429 || error.status === 503) {
      this.#budget.pauseFor((error.retryAfterSeconds ?? 5) * 1000)
    }
    return false
  }

  // ───────── Forgetting ─────────

  /**
   * The only way a conversation leaves the cache: left it myself, a newer removal tombstone, a snapshot without it, a read
   * that says I have no access. Everything stored for it goes in one step, and answers still in flight are discarded.
   */
  forgetConversation(
    id: string,
    reason: ForgetReason,
    marker?: { viewerVersion: number; membershipId: string | null },
  ): void {
    const scope = this.#scope
    if (scope === null) return
    const cs = this.#convs.get(id)
    if (cs !== undefined) {
      this.#clearConv(cs)
      this.#convs.delete(id)
    }
    this.#qc.removeQueries({ queryKey: syncKeys.conversation(scope, id) })
    this.#writeIndex(scope, forgetInIndex(this.#index(scope), id, marker))
    const at = this.#windows.indexOf(id)
    if (at !== -1) this.#windows.splice(at, 1)
    if (this.#open === id) this.#open = null
    const read = this.#reads.get(id)
    if (read !== undefined) this.#clearTimer(read.timer)
    this.#reads.delete(id)
    this.#hiddenLater.delete(id)
    this.#refetchQueue.delete(id)
    this.#refetchLast.delete(id)
    const queued = this.#pullQueue.indexOf(id)
    if (queued !== -1) this.#pullQueue.splice(queued, 1)
    syncUi.forget(id)
    this.#onConversationReset(id)
    this.#onForgotten(id, reason)
  }

  /** The relation is a different membership now: what was cached under the old one must not be readable any more. */
  #forgetMembership(scope: SyncScope, id: string, from: string, _to: string): void {
    this.#dropWindow(scope, id, from)
    this.#qc.removeQueries({ queryKey: syncKeys.members(scope, id) })
    this.#qc.removeQueries({ queryKey: syncKeys.bans(scope, id) })
    this.#qc.removeQueries({ queryKey: syncKeys.invites(scope, id) })
    const cs = this.#convs.get(id)
    if (cs !== undefined) {
      this.#clearConv(cs)
      cs.controller = new AbortController()
      cs.synced = null
      cs.pulling = false
      cs.pullToken = undefined
      cs.membershipId = null
    }
    const at = this.#windows.indexOf(id)
    if (at !== -1) this.#windows.splice(at, 1)
    syncUi.setTimeline(id, undefined)
    syncUi.setAnchor(id, undefined)
    // A read position claimed, or asked for, under the old membership says nothing about the new one: it would hide unread
    // messages there, or move a position that is not its own.
    const read = this.#reads.get(id)
    if (read !== undefined) this.#clearTimer(read.timer)
    this.#reads.delete(id)
    syncUi.setPendingRead(id, undefined)
    syncUi.setFailures(id, 0)
    // Unsent messages, the draft, a reply or an edit in progress: they were written under the membership that ended.
    this.#onConversationReset(id)
  }

  // ───────── Hints from the WebSocket ─────────

  /** A frame from the connection (already validated). Hints only raise what is *heard of*; reading is decided here. */
  onEvent(message: WsServerMessage): void {
    const scope = this.#scope
    if (scope === null) return
    switch (message.type) {
      case 'message.changed': {
        const { conversationId, changeSeq } = message.data
        const cs = this.#conv(conversationId)
        this.#observe(cs, changeSeq)
        if (!this.#ready) {
          this.#earlyHints.add(conversationId)
        } else if (cs.synced !== null) {
          this.#schedulePull(cs)
        } else {
          this.#hidePreview(scope, conversationId)
          this.#refetchSoon(conversationId)
        }
        return
      }
      case 'conversation.changed': {
        const cached = this.#index(scope).byId[message.data.conversationId]
        if (cached === undefined || message.data.metadataVersion > cached.metadataVersion) {
          this.#refetchOrDefer(message.data.conversationId)
        }
        return
      }
      case 'member.changed': {
        const { conversationId, membershipVersion } = message.data
        const cached = this.#index(scope).byId[conversationId]
        if (cached === undefined || membershipVersion > cached.membershipVersion) {
          this.#invalidateMembers(scope, conversationId)
          this.#refetchOrDefer(conversationId)
        }
        return
      }
      case 'user.changed':
      case 'conversation.removed':
        this.#observeUser(message.data.userChangeSeq)
        this.#schedulePersonalPull()
        return
      default:
        return
    }
  }

  /** The connection (re)opened: read the heads at once, whatever happened while it was away. */
  onHello(): void {
    this.#kickAll()
    void this.reconcile()
    this.#armReconcile()
  }

  /** The page came back to the front or the network returned. */
  onForeground(): void {
    this.#kickAll()
    void this.reconcile()
    this.#armReconcile()
  }

  /** Whatever was heard of and not yet applied is read now (a round may have been held back while offline). */
  #kickAll(): void {
    for (const cs of this.#convs.values()) this.#schedulePull(cs)
    this.#schedulePersonalPull()
  }

  #hidePreview(scope: SyncScope, id: string): void {
    const index = this.#index(scope)
    if (index.byId[id] === undefined || id in index.previewHidden) return
    this.#writeIndex(scope, { ...index, previewHidden: { ...index.previewHidden, [id]: true } })
  }

  #invalidateMembers(scope: SyncScope, id: string): void {
    for (const key of [
      syncKeys.members(scope, id),
      syncKeys.bans(scope, id),
      syncKeys.invites(scope, id),
    ]) {
      void this.#qc.invalidateQueries({ queryKey: key, refetchType: 'active' })
    }
  }

  // ───────── Re-reading conversations (batched) ─────────

  #refetchOrDefer(id: string): void {
    if (!this.#ready) this.#earlyHints.add(id)
    else this.#refetchSoon(id)
  }

  #refetchSoon(id: string): void {
    if (this.#scope === null || !this.#ready) return
    this.#refetchQueue.add(id)
    if (this.#refetchTimer !== undefined) return
    this.#refetchTimer = setTimeout(() => {
      this.#refetchTimer = undefined
      void this.#flushRefetch()
    }, REFETCH_BATCH_MS)
  }

  async #flushRefetch(): Promise<void> {
    const scope = this.#scope
    if (scope === null) return
    const now = this.#now()
    const due: string[] = []
    let later = Number.POSITIVE_INFINITY
    for (const id of this.#refetchQueue) {
      const wait = (this.#refetchLast.get(id) ?? Number.NEGATIVE_INFINITY) + REFETCH_GAP_MS - now
      if (wait <= 0) due.push(id)
      else later = Math.min(later, wait)
    }
    if (due.length === 0) {
      if (later !== Number.POSITIVE_INFINITY) this.#rearmRefetch(later)
      return
    }
    const wait = this.#budget.take()
    if (wait > 0) return this.#rearmRefetch(wait)
    for (const id of due) {
      this.#refetchQueue.delete(id)
      this.#refetchLast.set(id, now)
    }
    try {
      if (due.length >= LAGGING_LIST_AT) {
        const response = await this.#transport.listConversations(this.#controller.signal)
        if (!this.#live(scope)) return
        for (const conversation of response.conversations)
          this.#mergeConversation(scope, conversation)
      } else {
        // Two at a time: the rate limit is shared by every call of the account.
        for (let from = 0; from < due.length; from += 2) {
          await Promise.all(
            due
              .slice(from, from + 2)
              .map((id) => this.refreshConversation(id).catch(() => undefined)),
          )
          if (!this.#live(scope)) return
        }
      }
    } catch (error) {
      if (!this.#live(scope) || isAbort(error)) return
      this.#handleError(error, null)
      for (const id of due) this.#refetchQueue.add(id)
      this.#rearmRefetch(backoff(1))
    }
    if (this.#refetchQueue.size > 0) this.#rearmRefetch(REFETCH_GAP_MS)
  }

  #rearmRefetch(ms: number): void {
    this.#clearTimer(this.#refetchTimer)
    this.#refetchTimer = setTimeout(() => {
      this.#refetchTimer = undefined
      void this.#flushRefetch()
    }, ms)
  }

  // ───────── My own log ─────────

  #schedulePersonalPull(force = false): void {
    const scope = this.#scope
    const user = this.#user
    if (scope === null || !this.#ready || user.synced === null) return
    if (user.pulling) return
    if (!force && user.observed <= user.synced) return
    if (user.timer !== undefined) return
    const now = this.#now()
    const wait = Math.max(user.lastStart + USER_GAP_MS - now, user.retryAt - now, 0)
    if (wait > 0) {
      user.timer = setTimeout(() => {
        user.timer = undefined
        this.#schedulePersonalPull(force)
      }, wait)
      return
    }
    if (!this.#online()) return
    const budgetWait = this.#budget.take()
    if (budgetWait > 0) {
      user.timer = setTimeout(() => {
        user.timer = undefined
        this.#schedulePersonalPull(force)
      }, budgetWait)
      return
    }
    void this.#pullPersonal(scope)
  }

  async #pullPersonal(scope: SyncScope): Promise<void> {
    const user = this.#user
    user.pulling = true
    const startedAt = this.#now()
    user.lastStart = startedAt
    const signal = this.#controller.signal
    try {
      let response = await this.#transport.userChanges(
        { after: user.synced ?? 0, limit: LIMITS.changesPageMax },
        signal,
      )
      for (;;) {
        if (!this.#live(scope)) return
        if (response.resetRequired && response.baseline !== null) {
          this.#applyPersonalReset(scope, response.baseline)
          break
        }
        this.#applyPersonalPage(scope, response)
        if (response.nextCursor === null) break
        response = await this.#transport.userChanges({ cursor: response.nextCursor }, signal)
      }
      user.failures = 0
      syncUi.setUserFailures(0)
      if (user.synced !== null && user.observedAt <= startedAt && user.observed > user.synced) {
        user.observed = user.synced
      }
    } catch (error) {
      if (!this.#live(scope) || isAbort(error)) return
      if (!this.#handleError(error, null)) {
        user.failures += 1
        user.retryAt = Math.max(user.retryAt, this.#now() + backoff(user.failures))
        syncUi.setUserFailures(user.failures)
      }
    } finally {
      if (this.#live(scope)) {
        user.pulling = false
        this.#schedulePersonalPull()
      }
    }
  }

  #applyPersonalPage(scope: SyncScope, page: UserChangesResponse): void {
    for (const item of page.items) {
      switch (item.type) {
        case 'conversation':
          this.#mergeConversation(scope, item.conversation)
          break
        case 'conversation.removed': {
          const { index, forget } = applyRemoval(this.#index(scope), item)
          this.#writeIndex(scope, index)
          if (forget) {
            this.forgetConversation(item.conversationId, 'removed', {
              viewerVersion: item.viewerVersion,
              membershipId: item.membershipId,
            })
          }
          break
        }
        case 'message.hidden':
          this.#hideMessage(scope, item.conversationId, item.messageId)
          break
        case 'me':
          this.#writeMe(item.me)
          break
      }
    }
    this.#user.synced = Math.max(this.#user.synced ?? 0, page.scannedThrough)
    if (page.nextCursor === null) this.#user.synced = Math.max(this.#user.synced, page.through)
  }

  /** Rebuild from the consistent snapshot: what it does not contain is gone (it is the evidence of removal, docs/05 §2). */
  #applyPersonalReset(
    scope: SyncScope,
    baseline: NonNullable<UserChangesResponse['baseline']>,
  ): void {
    this.#writeMe(baseline.me)
    const present = new Set(baseline.conversations.map((conversation) => conversation.id))
    for (const conversation of baseline.conversations) this.#mergeConversation(scope, conversation)
    for (const [id, cached] of Object.entries(this.#index(scope).byId)) {
      // Archived conversations are not in the live list, so their absence proves nothing.
      if (cached.me !== null && cached.archivedAt === null && !present.has(id)) {
        this.forgetConversation(id, 'snapshot', {
          viewerVersion: cached.me.version + 1,
          membershipId: cached.me.membershipId,
        })
      }
    }
    this.#user.synced = baseline.baselineUserSeq
    this.#user.observed = baseline.baselineUserSeq
    this.#user.observedAt = this.#now()
  }

  #hideMessage(scope: SyncScope, conversationId: string, messageId: string): void {
    const membershipId = this.#index(scope).byId[conversationId]?.me?.membershipId
    const window =
      membershipId === undefined ? undefined : this.#window(scope, conversationId, membershipId)
    if (window === undefined) {
      const later = this.#hiddenLater.get(conversationId) ?? new Set<string>()
      later.add(messageId)
      this.#hiddenLater.set(conversationId, later)
      return
    }
    const next = hideInWindow(window, messageId)
    if (next !== window) this.#writeWindow(scope, next)
  }

  // ───────── Reconciliation ─────────

  #armReconcile(): void {
    this.#clearTimer(this.#reconcileTimer)
    this.#reconcileTimer = undefined
    if (this.#scope === null || !this.#ready) return
    // 24 to 30 seconds: with one catch-up round on top the last lost hint is repaired within 35 seconds (AT-01).
    const delay = RECONCILE_MS * (0.8 + 0.2 * this.#random())
    this.#reconcileTimer = setTimeout(() => {
      this.#reconcileTimer = undefined
      if (this.#visible() && this.#online()) void this.reconcile()
      this.#armReconcile()
    }, delay)
  }

  /** Reads the versions of everything the person can reach and queues whatever is behind. Never deletes on absence. */
  async reconcile(): Promise<void> {
    const scope = this.#scope
    if (scope === null || !this.#ready || this.#reconciling || !this.#online()) return
    if (this.#budget.take() > 0) return
    this.#reconciling = true
    try {
      const heads = await this.#transport.syncHeads(this.#controller.signal)
      if (!this.#live(scope)) return
      this.#observeUser(heads.userChangeSeq)
      const index = this.#index(scope)
      for (const head of heads.conversations) {
        const cached = index.byId[head.id]
        if (cached === undefined) continue
        if (head.metadataVersion > cached.metadataVersion) this.#refetchSoon(head.id)
        if (head.membershipVersion > cached.membershipVersion) {
          this.#invalidateMembers(scope, head.id)
          this.#refetchSoon(head.id)
        }
        const cs = this.#convs.get(head.id)
        if (cs !== undefined && cs.synced !== null) {
          this.#observe(cs, head.lastChangeSeq)
          this.#schedulePull(cs)
        } else if (head.lastChangeSeq > cached.lastChangeSeq) {
          this.#hidePreview(scope, head.id)
          this.#refetchSoon(head.id)
        }
      }
      this.#schedulePersonalPull()
    } catch (error) {
      if (!this.#live(scope) || isAbort(error)) return
      this.#handleError(error, null)
    } finally {
      this.#reconciling = false
    }
  }

  // ───────── Reading position ─────────

  /**
   * Asks the server to move my read position to `seq`. The client counts it as read at once (`pendingRead`); the request
   * itself is one at a time per conversation, at least a second apart, and always carries the newest wanted position.
   */
  markRead(id: string, seq: number): void {
    const scope = this.#scope
    if (scope === null) return
    const confirmed = this.#index(scope).byId[id]?.me?.lastReadSeq ?? 0
    const state = this.#reads.get(id) ?? {
      wanted: 0,
      inFlight: false,
      lastStart: 0,
      timer: undefined,
    }
    this.#reads.set(id, state)
    if (seq <= Math.max(confirmed, state.wanted)) return
    state.wanted = seq
    syncUi.setPendingRead(id, Math.max(useSyncUi.getState().pendingRead[id] ?? 0, seq))
    this.#flushRead(scope, id, state)
  }

  /**
   * My own message went out: the server moved my read position with it (D-083), so only the local claim is needed to keep
   * it from showing up as unread until my own log delivers the new position. No request.
   */
  noteSent(id: string, seq: number): void {
    syncUi.setPendingRead(id, Math.max(useSyncUi.getState().pendingRead[id] ?? 0, seq))
  }

  #flushRead(scope: SyncScope, id: string, state: ReadState): void {
    if (state.inFlight || state.timer !== undefined) return
    const confirmed = this.#index(scope).byId[id]?.me?.lastReadSeq ?? 0
    if (state.wanted <= confirmed) {
      this.#settleRead(id, state)
      return
    }
    const now = this.#now()
    const wait = Math.max(state.lastStart + READ_GAP_MS - now, 0) || this.#budget.take()
    if (wait > 0) {
      state.timer = setTimeout(() => {
        state.timer = undefined
        if (this.#live(scope) && this.#reads.get(id) === state) this.#flushRead(scope, id, state)
      }, wait)
      return
    }
    void this.#sendRead(scope, id, state)
  }

  async #sendRead(scope: SyncScope, id: string, state: ReadState): Promise<void> {
    state.inFlight = true
    state.lastStart = this.#now()
    const seq = state.wanted
    const asked = this.#index(scope).byId[id]?.me?.membershipId ?? null
    try {
      const conversation = await this.#transport.markRead(id, seq, this.#controller.signal)
      if (!this.#live(scope)) return
      this.#mergeConversation(scope, conversation)
    } catch (error) {
      if (!this.#live(scope) || isAbort(error)) return
      // Asked under a membership that is not the one held now: says nothing about it.
      if ((this.#index(scope).byId[id]?.me?.membershipId ?? null) !== asked) return
      this.#handleError(error, id)
    } finally {
      state.inFlight = false
      // A state that was taken out of the table (the conversation was forgotten, or the membership ended) is not served any
      // more: what it still wants was wanted under something that is gone.
      if (this.#live(scope) && this.#reads.get(id) === state) {
        this.#settleRead(id, state)
        this.#flushRead(scope, id, state)
      }
    }
  }

  /** Clears the local claim once the server confirms at least that position. */
  #settleRead(id: string, state: ReadState): void {
    const scope = this.#scope
    const confirmed = scope === null ? 0 : (this.#index(scope).byId[id]?.me?.lastReadSeq ?? 0)
    const claimed = useSyncUi.getState().pendingRead[id]
    if (claimed !== undefined && confirmed >= claimed) syncUi.setPendingRead(id, undefined)
    if (state.wanted <= confirmed && !state.inFlight) state.wanted = 0
  }

  // ───────── For tests and diagnostics ─────────

  /** What the engine has heard of and applied for a conversation. */
  progress(id: string): { observed: number; synced: number | null } | undefined {
    const cs = this.#convs.get(id)
    return cs === undefined ? undefined : { observed: cs.observed, synced: cs.synced }
  }

  userProgress(): { observed: number; synced: number | null } {
    return { observed: this.#user.observed, synced: this.#user.synced }
  }
}
