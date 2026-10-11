/**
 * Merging notifications by entity version (docs/05 section 2, D-082): a read, a log page and a write answer can arrive in
 * any order, and the one with the higher `version` of an entry is the one that is kept, so an older answer can never put an
 * unread mark back. The list is newest first by creation time, then id; nothing here reads a store or a clock.
 */
import type { Notification } from '@chatapp/contracts'

export type NoticeList = {
  items: Notification[]
}

const newer = (a: Notification, b: Notification): number =>
  a.createdAt < b.createdAt
    ? 1
    : a.createdAt > b.createdAt
      ? -1
      : a.id < b.id
        ? 1
        : a.id > b.id
          ? -1
          : 0

/** Merges entries into the list; an entry replaces the known one only with a higher version. Returns the same list when nothing changed. */
export function mergeNotifications(
  list: NoticeList,
  incoming: readonly Notification[],
  freshProjection = false,
): NoticeList {
  if (incoming.length === 0) return list
  const known = new Map(list.items.map((item) => [item.id, item]))
  let changed = false
  for (const entry of incoming) {
    const current = known.get(entry.id)
    if (current !== undefined && current.version >= entry.version) {
      // The row's version describes its read state, not its source. A freshly authorized read may withdraw or redact the
      // source without changing that version; keep the newer read state while replacing only the projection.
      if (!freshProjection || JSON.stringify(current.data) === JSON.stringify(entry.data)) continue
      known.set(entry.id, { ...current, data: entry.data } as Notification)
    } else {
      known.set(entry.id, entry)
    }
    changed = true
  }
  if (!changed) return list
  return { items: [...known.values()].sort(newer) }
}

/** How many of the known entries are unread: the floor the displayed count never goes below. */
export const unreadKnown = (list: NoticeList): number =>
  list.items.reduce((n, item) => (item.readAt === null ? n + 1 : n), 0)

/**
 * The count to show. The server's count is the truth for everything, including entries on pages not loaded; but an answer
 * to an earlier question must not undo what a later one already said, and entries known here are at least that many.
 */
export function displayedUnread(serverCount: number | null, list: NoticeList): number {
  return Math.max(serverCount ?? 0, unreadKnown(list))
}
