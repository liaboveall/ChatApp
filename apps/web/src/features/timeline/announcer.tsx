/**
 * The live region that tells a screen reader about new messages of the open conversation (docs/02 section 7). It only
 * looks at messages that arrive while the screen is open (the ones that were there at the start are not read out), waits
 * for a quiet moment so a burst becomes one sentence, and never reads a window that is looking at older history.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TimelineWindow, UsersByid } from '@/lib/sync/types.ts'
import { m } from '@/paraglide/messages.js'
import { type AnnounceWords, announcementOf, type Incoming, incomingAfter } from './announce.ts'

/** How long to wait for more messages before reading what has come. */
const QUIET_MS = 1200
/** The longest a message waits to be read, however busy the conversation. */
const LONGEST_MS = 4000

const WORDS: AnnounceWords = {
  one: (sender, text) => m.announce_message({ sender, text }),
  many: (count, sender, text) => m.announce_messages({ count, sender, text }),
}

export function MessageAnnouncer({
  window: win,
  users,
  meId,
}: {
  window: TimelineWindow
  users: UsersByid
  meId: string
}) {
  const [said, setSaid] = useState({ text: '', n: 0 })
  const seen = useRef<number | null>(null)
  const batch = useRef<Incoming[]>([])
  const quiet = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const longest = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Reads out what has collected. It only touches refs and the state setter, so it never changes between renders.
  const flush = useCallback((): void => {
    clearTimeout(quiet.current)
    clearTimeout(longest.current)
    quiet.current = undefined
    longest.current = undefined
    const text = announcementOf(batch.current, WORDS)
    batch.current = []
    if (text !== '') setSaid((old) => ({ text, n: old.n + 1 }))
  }, [])

  useEffect(() => {
    const newest = win.messages[win.messages.length - 1]
    if (seen.current === null) {
      // The first look: what is here already is not news.
      seen.current = newest?.seq ?? 0
      return
    }
    if (win.hasMoreAfter) return
    const fresh = incomingAfter(win.messages, seen.current, meId, (senderId) => {
      const user = senderId === null ? undefined : users[senderId]
      return user === undefined
        ? m.user_member()
        : user.deleted
          ? m.user_deleted()
          : user.displayName
    })
    seen.current = Math.max(seen.current, newest?.seq ?? 0)
    if (fresh.length === 0) return
    batch.current.push(...fresh)
    clearTimeout(quiet.current)
    quiet.current = setTimeout(flush, QUIET_MS)
    longest.current ??= setTimeout(flush, LONGEST_MS)
  }, [win, users, meId, flush])

  useEffect(
    () => () => {
      clearTimeout(quiet.current)
      clearTimeout(longest.current)
    },
    [],
  )

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      <span key={said.n}>{said.text}</span>
    </div>
  )
}
