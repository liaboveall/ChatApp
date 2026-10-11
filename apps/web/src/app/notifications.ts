/**
 * Reading and marking the person's notifications (docs/05 section 3.7, M6). Every request is made for the person in front of
 * the screen (`forScreen`, D-174): an answer that comes after they signed out, or somebody else signed in, is dropped. The
 * engine tells this module what the personal log brought (`onNotifications`) and when the list may be out of date
 * (`onNotificationsStale`); a short pause batches a burst of those into one read.
 */
import {
  type MarkNotificationsRead,
  markNotificationsReadResponseSchema,
  notificationPageSchema,
} from '@chatapp/contracts'
import { engine, forScreen } from '@/app/sync.ts'
import { api } from '@/lib/api.ts'
import { noticeProjectionEpoch, notices, useNotices } from '@/lib/notifications/store.ts'
import { registerStoreReset } from '@/lib/sync/stores.ts'

const FIRST_PAGE = 30
const REFRESH_DELAY_MS = 300

/** Counts the questions asked, so an older answer never overrides what a later one said about the unread count. */
let turn = 0
let timer: ReturnType<typeof setTimeout> | undefined

registerStoreReset(() => {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  turn += 1
})

/** Reads the newest page and merges it: the unread count and any entry a hint or the log did not bring. */
export async function refreshNotices(): Promise<boolean> {
  const mine = ++turn
  const epoch = noticeProjectionEpoch()
  const count = Math.max(FIRST_PAGE, useNotices.getState().items.length)
  if (!useNotices.getState().loaded) notices.loading(true)
  try {
    const page = await forScreen(null, () =>
      api(`/api/notifications?limit=${FIRST_PAGE}`, { schema: notificationPageSchema }),
    )
    if (page === null) return false
    // Re-project every loaded page, including old entries outside the newest thirty. A notification's source can change
    // without changing its own row version, and expired entries can disappear entirely.
    const items = [...page.items]
    let nextCursor = page.nextCursor
    while (nextCursor !== null && items.length < count) {
      if (epoch !== noticeProjectionEpoch()) return false
      const older = await forScreen(null, () =>
        api(
          `/api/notifications?limit=${FIRST_PAGE}&cursor=${encodeURIComponent(nextCursor ?? '')}`,
          {
            schema: notificationPageSchema,
          },
        ),
      )
      if (older === null) return false
      items.push(...older.items)
      nextCursor = older.nextCursor
    }
    const installed = notices.firstPage({ ...page, items, nextCursor }, mine, epoch)
    if (!installed) refreshNoticesSoon()
    return installed
  } catch {
    // Offline or the server is busy: what is known stays on screen, and the next hint or reconnect reads again.
    notices.failed()
    return false
  }
}

/** A click can land while a hint erased its source. Resolve it afresh; never reuse that erased render-time target. */
export async function refreshNoticesForClick(): Promise<boolean> {
  const ticket = engine.ticket(null)
  // A hint or a newer concurrent read may overtake this read. Bound the coalescing effort and leave the panel open if
  // traffic or a failed connection prevents a current projection; the person can try again.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!engine.isCurrent(ticket)) return false
    const installed = await refreshNotices()
    if (!engine.isCurrent(ticket)) return false
    if (installed) return true
  }
  return false
}

/** Reads again shortly: several hints in a row are one question. */
export function refreshNoticesSoon(): void {
  if (timer !== undefined) return
  timer = setTimeout(() => {
    timer = undefined
    void refreshNotices()
  }, REFRESH_DELAY_MS)
}

/** The next older page, when the list was scrolled to its end. */
export async function loadOlderNotices(): Promise<void> {
  const mine = ++turn
  const epoch = noticeProjectionEpoch()
  const { nextCursor, loading } = useNotices.getState()
  if (!nextCursor || loading) return
  notices.loading(true)
  try {
    const page = await forScreen(null, () =>
      api(`/api/notifications?limit=${FIRST_PAGE}&cursor=${encodeURIComponent(nextCursor)}`, {
        schema: notificationPageSchema,
      }),
    )
    if (page === null) return
    if (!notices.olderPage(page, mine, epoch)) refreshNoticesSoon()
  } catch {
    notices.loading(false)
  }
}

/** Marks entries read; the answer carries their new versions and the count. Returns whether the server took it. */
export async function markNoticesRead(request: MarkNotificationsRead): Promise<boolean> {
  const mine = ++turn
  try {
    const answer = await forScreen(null, () =>
      api('/api/notifications/read', {
        method: 'POST',
        json: request,
        schema: markNotificationsReadResponseSchema,
      }),
    )
    if (answer === null) return false
    notices.marked(answer.items, answer.unreadCount, mine)
    // After "all" the answer lists nothing: the entries themselves are read again.
    await refreshNotices()
    return true
  } catch {
    return false
  }
}

/** A source changed or its access ended: erase it now and read it again under the new boundary. */
export function invalidateNoticeSources(conversationId?: string): void {
  notices.invalidateSources(conversationId)
  refreshNoticesSoon()
}
