/**
 * The rows of a timeline, built from a window (docs/01 section 4.5, D-151, D-152): grouping of consecutive messages,
 * the separators between them, the boundary at the top, and the messages still being sent. Pure: the same input gives
 * the same rows, and nothing here knows about React or the DOM.
 *
 * A separator (a new day or a gap of more than an hour, the "new messages" line) belongs to the row *above* it and is
 * drawn under it. That way loading older messages never changes the size of a row that is on screen: the only row that
 * gains or loses a separator is the last row of the page that was just added, above the viewport, where the list
 * compensates for it. Putting separators above their row would change the old top row at that very moment.
 */
import type { Conversation, Message } from '@chatapp/contracts'
import type { PendingMessage } from '@/lib/sync/outbox.ts'
import type { TimelineWindow } from '@/lib/sync/types.ts'
import { differentDay } from '@/lib/time-format.ts'

/** Consecutive messages of one sender within this many milliseconds form a group. */
export const GROUP_GAP_MS = 3 * 60_000
/** A gap longer than this between two messages gets a time separator. */
export const SEPARATOR_GAP_MS = 60 * 60_000

export type After = {
  /** The instant a time separator below this row announces (the next message's time), or null. */
  date: string | null
  /** The "new messages" line sits below this row. */
  unread: boolean
}

type Base = { key: string; after: After }

export type StartItem = Base & {
  type: 'start'
  /** Reading from the first message the person can see (they joined later), or from the very beginning. */
  boundary: 'joined' | 'beginning'
}

type Bubble = {
  who: 'me' | 'other' | 'system'
  /** First and last row of its group: the name goes above the first, the avatar beside the last. */
  first: boolean
  last: boolean
  showName: boolean
  showAvatar: boolean
}

export type MessageItem = Base &
  Bubble & {
    type: 'message'
    message: Message
    /** A line of grey centred text instead of a bubble. */
    notice: 'system' | 'recalled' | 'deleted' | null
    /** The first message after the "new messages" line. */
    firstUnread: boolean
  }

export type PendingItem = Base &
  Bubble & {
    type: 'pending'
    pending: PendingMessage
  }

export type TimelineItem = StartItem | MessageItem | PendingItem

export type BuiltTimeline = {
  items: TimelineItem[]
  /** The "new messages" line belongs above the very first row (there is no row above it to carry it). */
  leadingUnread: boolean
}

export type BuildInput = {
  window: TimelineWindow
  /** Messages being sent (only shown when the window reaches the newest message). */
  pending: PendingMessage[]
  meId: string
  conversation: Pick<Conversation, 'kind'> & {
    me: Pick<NonNullable<Conversation['me']>, 'visibleFromSeq'> | null
  }
  /** Messages after this `seq` are new; undefined: no separator. */
  anchor: number | undefined
  timeZone?: string
}

const noticeOf = (message: Message): MessageItem['notice'] =>
  message.deletedAt !== null
    ? 'deleted'
    : message.recalledAt !== null
      ? 'recalled'
      : message.kind === 'system'
        ? 'system'
        : null

/** Whether a time separator is needed between two instants. */
function needsDate(previous: string, next: string, timeZone: string | undefined): boolean {
  return (
    Date.parse(next) - Date.parse(previous) > SEPARATOR_GAP_MS ||
    differentDay(previous, next, timeZone)
  )
}

type Row = { key: string; sender: string | null; at: string; plain: boolean; item: TimelineItem }

export function buildItems(input: BuildInput): BuiltTimeline {
  const { window, meId, conversation, anchor, timeZone } = input
  const showNames = conversation.kind !== 'dm'
  const rows: Row[] = []
  const items: TimelineItem[] = []

  if (!window.hasMoreBefore) {
    const visibleFrom = conversation.me?.visibleFromSeq ?? 0
    const start: StartItem = {
      key: 'start',
      type: 'start',
      boundary: visibleFrom > 0 ? 'joined' : 'beginning',
      after: { date: null, unread: false },
    }
    items.push(start)
  }

  const who = (senderId: string | null, notice: MessageItem['notice']): Bubble['who'] =>
    notice === 'system' ? 'system' : senderId === meId ? 'me' : 'other'

  let seenUnread = anchor === undefined
  let leadingUnread = false
  let previousAt: string | null = null
  let previousItem: TimelineItem | undefined = items[0]

  const place = (
    item: MessageItem | PendingItem,
    at: string,
    sender: string | null,
    plain: boolean,
  ): void => {
    // The time separator for this row hangs under the row above it.
    if (previousItem !== undefined) {
      if (previousAt === null) {
        // The start item: the first message always has a separator above it.
        previousItem.after.date = at
      } else if (needsDate(previousAt, at, timeZone)) {
        previousItem.after.date = at
      }
    }
    rows.push({ key: item.key, sender, at, plain, item })
    items.push(item)
    previousItem = item
    previousAt = at
  }

  for (const message of window.messages) {
    const notice = noticeOf(message)
    const isNew = !seenUnread && anchor !== undefined && message.seq > anchor
    const firstUnread = isNew && message.senderId !== meId && message.kind !== 'system'
    if (firstUnread) {
      seenUnread = true
      if (previousItem === undefined) leadingUnread = true
      else previousItem.after.unread = true
    }
    const who_ = who(message.senderId, notice)
    const item: MessageItem = {
      key: `m:${message.id}`,
      type: 'message',
      message,
      notice,
      who: who_,
      first: true,
      last: true,
      showName: false,
      showAvatar: false,
      firstUnread,
      after: { date: null, unread: false },
    }
    place(item, message.createdAt, message.senderId, notice === null)
  }

  if (!window.hasMoreAfter) {
    for (const pending of input.pending) {
      const item: PendingItem = {
        key: `o:${pending.clientId}`,
        type: 'pending',
        pending,
        who: 'me',
        first: true,
        last: true,
        showName: false,
        showAvatar: false,
        after: { date: null, unread: false },
      }
      place(item, pending.createdAt, meId, true)
    }
  }

  // Grouping: a row joins the group above when it is a plain bubble from the same sender within the gap and nothing
  // (a separator, a notice) lies between them.
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const above = rows[index - 1]
    if (row === undefined) continue
    const item = row.item
    if (item.type === 'start') continue
    const joins =
      above !== undefined &&
      above.item.type !== 'start' &&
      row.plain &&
      above.plain &&
      row.sender !== null &&
      row.sender === above.sender &&
      above.item.after.date === null &&
      !above.item.after.unread &&
      Date.parse(row.at) - Date.parse(above.at) <= GROUP_GAP_MS
    if (joins && above !== undefined && above.item.type !== 'start') {
      above.item.last = false
      item.first = false
    }
  }
  for (const row of rows) {
    const item = row.item
    if (item.type === 'start' || !row.plain) continue
    item.showName = showNames && item.who === 'other' && item.first
    item.showAvatar = showNames && item.who === 'other' && item.last
  }

  return { items, leadingUnread }
}

/** The loaded run of messages: start item, rows and pending rows, as the list's keys in order. */
export const keysOf = (built: BuiltTimeline): string[] => built.items.map((item) => item.key)
