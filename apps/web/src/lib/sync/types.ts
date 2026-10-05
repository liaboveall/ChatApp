/**
 * The shapes the client keeps for conversations (docs/05 section 4.5, D-150). TanStack Query is only the store and the
 * subscription mechanism: everything below is plain data (no Set, no Map, nothing a later persistence step could not
 * serialize), and it only changes through the pure functions in `merge.ts` and `window.ts`.
 */
import type { Conversation, Message, UserSummary } from '@chatapp/contracts'

/**
 * Who a request, or an answer that comes back, belongs to. Object identity is the check: `start` and `switchScope`
 * create a new one and `stop` drops it, so an answer to a request made under an older one is simply not the current
 * scope any more and is discarded without a trace (docs/05 section 2, last paragraph).
 */
export type SyncScope = {
  readonly userId: string
  readonly authEpoch: number
  readonly restoreEpoch: string
  /** How many scopes this tab has had; only here to tell two scopes of the same person apart in logs and tests. */
  readonly generation: number
}

/** What the client knows of a membership that ended: a stale answer must not bring the conversation back (D-150). */
export type RemovedMarker = { viewerVersion: number; membershipId: string | null }

export type ConversationIndex = {
  byId: Record<string, Conversation>
  /** Removal tombstones seen so far, by conversation id. */
  removed: Record<string, RemovedMarker>
  /** Conversations whose preview is not shown until a fresh read: two versions that cannot be ordered met. */
  previewHidden: Record<string, true>
}

export type UsersByid = Record<string, UserSummary>

/**
 * One continuous run of a conversation's messages, ascending by `seq`, every message the reader may see between its ends
 * (the catch-up guarantees that). `hasMoreAfter` false means the window reaches the newest message ("attached").
 */
export type TimelineWindow = {
  conversationId: string
  membershipId: string
  messages: Message[]
  hasMoreBefore: boolean
  hasMoreAfter: boolean
  /** Messages I deleted for myself: they never re-enter the window. */
  hidden: Record<string, true>
  /** Messages that left the window by tombstone, with the change that took them: only a newer version may bring one back. */
  gone: Record<string, number>
  /** Counts structural changes, so a view can tell "same list" from "list changed at the top" cheaply. */
  revision: number
}

export type PreviewVersion = { lastChangeSeq: number; viewerVersion: number }

/** Things a merge decided that the caller (the engine) has to carry out; the merge itself stays pure. */
export type ConversationEffect =
  /** The relation to this conversation is a different membership now: its old cache must go in the same step. */
  | { type: 'membership-changed'; conversationId: string; from: string; to: string }
  /** The two previews cannot be ordered: hide the cached one and read the conversation again. */
  | { type: 'preview-incomparable'; conversationId: string }
