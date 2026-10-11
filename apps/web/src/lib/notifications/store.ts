/**
 * The notification centre's state on this device (docs/05 section 2, M6): what is known of the person's notifications and
 * how many are unread. Entries are merged by version; the unread count is the server's last answer from the *latest question
 * asked* (an older answer arriving late never overrides a newer one), and never shown lower than what is known here.
 * Registered for reset like every store that holds account data (D-070, SEC-34).
 */
import type { Notification, NotificationPage } from '@chatapp/contracts'
import { create } from 'zustand'
import { registerConversationReset, registerStoreReset } from '@/lib/sync/stores.ts'
import { displayedUnread, mergeNotifications } from './merge.ts'

export type NoticeState = {
  items: Notification[]
  /** Where the next older page starts; null once the end was reached, undefined before the first page. */
  nextCursor: string | null | undefined
  serverUnread: number | null
  /** The number of the question that produced `serverUnread`. */
  countTurn: number
  loaded: boolean
  loading: boolean
  /** The first read failed and there is nothing to show yet. */
  failed: boolean
}

const initial = (): NoticeState => ({
  items: [],
  nextCursor: undefined,
  serverUnread: null,
  countTurn: 0,
  loaded: false,
  loading: false,
  failed: false,
})

export const useNotices = create<NoticeState>()(initial)

// A row version covers readAt. Source projections also depend on membership, message state and role: reads started before
// one of those changes may never restore the old content, even if the notification version itself is higher.
let projectionEpoch = 0
let projectionTurn = 0

export const noticeProjectionEpoch = (): number => projectionEpoch

const withoutSource = (entry: Notification): Notification =>
  entry.type === 'budget_alert' ? entry : { ...entry, data: { available: false } }

const conversationOf = (entry: Notification): string | null => {
  if (!('available' in entry.data) || !entry.data.available) return null
  if ('conversation' in entry.data) return entry.data.conversation.id
  if ('conversationId' in entry.data) return entry.data.conversationId
  return null
}

export const unreadOfNotices = (state: Pick<NoticeState, 'items' | 'serverUnread'>): number =>
  displayedUnread(state.serverUnread, { items: state.items })

export const useUnreadNotices = (): number => useNotices(unreadOfNotices)

export const notices = {
  /** Entries from the personal log or a write answer. */
  ingest(items: readonly Notification[]): void {
    useNotices.setState((state) => {
      // The personal log can have been read before a source was revoked. It conveys row versions only; a separate, guarded
      // read projects their sources after the change.
      const merged = mergeNotifications({ items: state.items }, items.map(withoutSource))
      return merged.items === state.items ? state : { items: merged.items }
    })
  },
  /** The first page, asked as question number `turn`. */
  firstPage(page: NotificationPage, turn: number, epoch = projectionEpoch): boolean {
    if (epoch !== projectionEpoch || turn < projectionTurn) return false
    projectionTurn = turn
    useNotices.setState((state) => {
      const merged = mergeNotifications({ items: state.items }, page.items, true)
      return {
        // This is a fresh snapshot of all loaded pages, so absent/expired entries and a former administrator's alerts go.
        items: merged.items.filter((item) => page.items.some((entry) => entry.id === item.id)),
        nextCursor: page.nextCursor,
        ...(turn >= state.countTurn ? { serverUnread: page.unreadCount, countTurn: turn } : {}),
        loaded: true,
        loading: false,
        failed: false,
      }
    })
    return true
  },
  /** An older page, loaded by scrolling to the end. */
  olderPage(page: NotificationPage, turn: number, epoch: number): boolean {
    if (epoch !== projectionEpoch || turn < projectionTurn) return false
    projectionTurn = turn
    useNotices.setState((state) => ({
      items: mergeNotifications({ items: state.items }, page.items, true).items,
      nextCursor: page.nextCursor,
      loading: false,
    }))
    return true
  },
  /** The answer to marking read, asked as question number `turn`. */
  marked(items: readonly Notification[], unreadCount: number, turn: number): void {
    useNotices.setState((state) => ({
      items: mergeNotifications({ items: state.items }, items.map(withoutSource)).items,
      ...(turn >= state.countTurn ? { serverUnread: unreadCount, countTurn: turn } : {}),
    }))
  },
  loading(on: boolean): void {
    useNotices.setState({ loading: on })
  },
  failed(): void {
    useNotices.setState((state) => ({ loading: false, failed: !state.loaded }))
  },
  reset(): void {
    projectionEpoch += 1
    projectionTurn = 0
    useNotices.setState(initial(), true)
  },
  /** Forget projected sources synchronously. A subsequent read may restore only what is still authorized. */
  invalidateSources(conversationId?: string): void {
    projectionEpoch += 1
    useNotices.setState((state) => ({
      items: state.items
        .filter((entry) => conversationId !== undefined || entry.type !== 'budget_alert')
        .map((entry) =>
          conversationId === undefined || conversationOf(entry) === conversationId
            ? withoutSource(entry)
            : entry,
        ),
    }))
  },
}

registerStoreReset(notices.reset)
registerConversationReset((id) => notices.invalidateSources(id))
