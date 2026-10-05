/**
 * The timeline window of one conversation (D-151): a single continuous run of messages, ascending by `seq`, that
 * grows at the top when the reader scrolls up, grows at the bottom while it is attached to the newest message, and is
 * trimmed from the far end beyond a fixed size. These are pure functions on plain data; an unchanged window comes back as
 * the same object.
 */
import type { Message } from '@chatapp/contracts'
import { cascadeReplies, mergeMessage } from './merge.ts'
import type { TimelineWindow } from './types.ts'

/** Most messages one window keeps (docs/03 section 10). */
export const WINDOW_MAX = 2000

export type PageLike = { messages: Message[]; hasMoreBefore: boolean; hasMoreAfter: boolean }

export function emptyWindow(conversationId: string, membershipId: string): TimelineWindow {
  return {
    conversationId,
    membershipId,
    messages: [],
    hasMoreBefore: false,
    hasMoreAfter: false,
    hidden: {},
    gone: {},
    revision: 0,
  }
}

/** The lowest and highest `seq` the window holds, or null when it is empty. */
export function windowRange(window: TimelineWindow): { min: number; max: number } | null {
  const first = window.messages[0]
  const last = window.messages[window.messages.length - 1]
  return first === undefined || last === undefined ? null : { min: first.seq, max: last.seq }
}

/** Whether a version of a message may enter the window: not one I deleted for myself, and newer than a tombstone. */
function admissible(window: Pick<TimelineWindow, 'hidden' | 'gone'>, message: Message): boolean {
  if (message.id in window.hidden) return false
  const left = window.gone[message.id]
  return left === undefined || message.changeSeq > left
}

/** The same list when it is already ascending by `seq`, otherwise a sorted copy (catch-up arrives in log order). */
function ascending(messages: Message[]): Message[] {
  for (let index = 1; index < messages.length; index += 1) {
    const before = messages[index - 1]
    const here = messages[index]
    if (before !== undefined && here !== undefined && before.seq > here.seq) {
      return messages.slice().sort((a, b) => a.seq - b.seq)
    }
  }
  return messages
}

/** Folds `incoming` into `existing` by message id (each by its version) and keeps the result ascending by `seq`. */
function union(existing: Message[], rawIncoming: Message[]): Message[] {
  if (rawIncoming.length === 0) return existing
  const incoming = ascending(rawIncoming)
  if (existing.length === 0) return incoming
  const firstExisting = existing[0]
  const lastExisting = existing[existing.length - 1]
  const firstIncoming = incoming[0]
  const lastIncoming = incoming[incoming.length - 1]
  if (
    firstExisting !== undefined &&
    lastExisting !== undefined &&
    firstIncoming !== undefined &&
    lastIncoming !== undefined
  ) {
    // The two common shapes: a page entirely above the window, or entirely below it.
    if (lastIncoming.seq < firstExisting.seq) return [...incoming, ...existing]
    if (firstIncoming.seq > lastExisting.seq) return [...existing, ...incoming]
  }
  const byId = new Map(existing.map((message) => [message.id, message]))
  for (const message of incoming) byId.set(message.id, mergeMessage(byId.get(message.id), message))
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

const bump = (window: TimelineWindow, patch: Partial<TimelineWindow>): TimelineWindow => ({
  ...window,
  ...patch,
  revision: window.revision + 1,
})

/** Revives messages that a newer version brought back from a tombstone. */
function withoutRevived(gone: Record<string, number>, revived: Message[]): Record<string, number> {
  let next = gone
  for (const message of revived) {
    if (message.id in next) {
      const { [message.id]: _left, ...rest } = next
      next = rest
    }
  }
  return next
}

/** A window from a page that was just read (the newest page, or one around a message). */
export function windowFromPage(
  conversationId: string,
  membershipId: string,
  page: PageLike,
  previous?: Pick<TimelineWindow, 'hidden' | 'gone'>,
): TimelineWindow {
  const base = {
    ...emptyWindow(conversationId, membershipId),
    hidden: previous?.hidden ?? {},
    gone: previous?.gone ?? {},
  }
  const messages = page.messages.filter((message) => admissible(base, message))
  return {
    ...base,
    messages: messages.slice().sort((a, b) => a.seq - b.seq),
    hasMoreBefore: page.hasMoreBefore,
    hasMoreAfter: page.hasMoreAfter,
    gone: withoutRevived(base.gone, messages),
    revision: 1,
  }
}

/** An older page joins at the top. */
export function prependPage(window: TimelineWindow, page: PageLike): TimelineWindow {
  const incoming = page.messages.filter((message) => admissible(window, message))
  return bump(window, {
    messages: union(window.messages, incoming),
    hasMoreBefore: page.hasMoreBefore,
    gone: withoutRevived(window.gone, incoming),
  })
}

/** A newer page joins at the bottom (a window that is not attached to the newest message loads downward). */
export function appendPage(window: TimelineWindow, page: PageLike): TimelineWindow {
  const incoming = page.messages.filter((message) => admissible(window, message))
  return bump(window, {
    messages: union(window.messages, incoming),
    hasMoreAfter: page.hasMoreAfter,
    gone: withoutRevived(window.gone, incoming),
  })
}

/**
 * Catch-up (and write answers): messages that changed, and tombstones of messages that left my view. A message already in
 * the window is replaced by a newer version; a new one is placed where `seq` puts it when it falls inside the window or
 * extends an end the window is attached to. Whatever lies beyond an end that has more is left for scrolling to load.
 * Quotes of every changed message are brought along, in the window or not (their own versions do not move).
 */
export function mergeChanges(
  window: TimelineWindow,
  items: Message[],
  tombstones: ReadonlyArray<{ id: string; changeSeq: number }> = [],
): TimelineWindow {
  let messages = window.messages
  let gone = window.gone
  let touched = false

  for (const tombstone of tombstones) {
    const index = messages.findIndex((message) => message.id === tombstone.id)
    const at = index === -1 ? undefined : messages[index]
    if (at !== undefined && tombstone.changeSeq >= at.changeSeq) {
      messages = [...messages.slice(0, index), ...messages.slice(index + 1)]
      touched = true
    } else if (at !== undefined) {
      continue
    }
    if ((gone[tombstone.id] ?? -1) < tombstone.changeSeq) {
      gone = { ...gone, [tombstone.id]: tombstone.changeSeq }
      touched = true
    }
  }

  const probe = { hidden: window.hidden, gone }
  const range = (): { min: number; max: number } | null => {
    const first = messages[0]
    const last = messages[messages.length - 1]
    return first === undefined || last === undefined ? null : { min: first.seq, max: last.seq }
  }
  let added: Map<string, Message> | undefined
  let replaced: Map<number, Message> | undefined
  const present = new Map(messages.map((message, index) => [message.id, index]))
  for (const item of items) {
    if (!admissible(probe, item)) continue
    const index = present.get(item.id)
    if (index !== undefined) {
      const before = replaced?.get(index) ?? messages[index]
      const merged = mergeMessage(before, item)
      if (merged !== before) {
        replaced ??= new Map()
        replaced.set(index, merged)
      }
      continue
    }
    const bounds = range()
    const inside = bounds !== null && item.seq >= bounds.min && item.seq <= bounds.max
    const belowOpenEnd = (bounds === null || item.seq > bounds.max) && !window.hasMoreAfter
    const aboveOpenStart = bounds !== null && item.seq < bounds.min && !window.hasMoreBefore
    if (inside || belowOpenEnd || aboveOpenStart) {
      added ??= new Map()
      added.set(item.id, mergeMessage(added.get(item.id), item))
    }
  }

  if (replaced !== undefined) {
    const next = messages.slice()
    for (const [index, message] of replaced) next[index] = message
    messages = next
    touched = true
  }
  if (added !== undefined) {
    const fresh = [...added.values()]
    messages = union(messages, fresh)
    gone = withoutRevived(gone, fresh)
    touched = true
  }

  let cascaded = messages
  for (const item of items) cascaded = cascadeReplies(cascaded, item)
  if (cascaded !== messages) {
    messages = cascaded
    touched = true
  }

  return touched ? bump(window, { messages, gone }) : window
}

/** I deleted this message for myself: it leaves the window for good, and quotes of it read "unavailable". */
export function hideInWindow(window: TimelineWindow, messageId: string): TimelineWindow {
  const index = window.messages.findIndex((message) => message.id === messageId)
  const already = messageId in window.hidden
  if (index === -1 && already) return window
  const remaining =
    index === -1
      ? window.messages
      : [...window.messages.slice(0, index), ...window.messages.slice(index + 1)]
  return bump(window, {
    messages: cascadeReplies(remaining, { id: messageId, hidden: true }),
    hidden: already ? window.hidden : { ...window.hidden, [messageId]: true },
  })
}

/** Drops the newest messages beyond `max`; the window is no longer attached to the newest message. */
export function trimNewest(window: TimelineWindow, max = WINDOW_MAX): TimelineWindow {
  if (window.messages.length <= max) return window
  return bump(window, { messages: window.messages.slice(0, max), hasMoreAfter: true })
}

/** Drops the oldest messages beyond `max` (a window that grew downward). */
export function trimOldest(window: TimelineWindow, max = WINDOW_MAX): TimelineWindow {
  if (window.messages.length <= max) return window
  return bump(window, {
    messages: window.messages.slice(window.messages.length - max),
    hasMoreBefore: true,
  })
}

/** The newest message that is really in the window (a window attached to the newest message holds it). */
export function newestOf(window: TimelineWindow): Message | undefined {
  return window.messages[window.messages.length - 1]
}
