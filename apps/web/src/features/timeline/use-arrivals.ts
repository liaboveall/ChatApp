import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { springEasing, springs } from '@/design/tokens.ts'
import { arrivalsOf } from './arrivals.ts'
import type { TimelineItem } from './items.ts'

/** What a row that has just arrived shows (docs/02 section 4.5). */
export type RowArrival = {
  /** The row is making its entrance: it opens its room and the bubble springs in. */
  entering: boolean
  /**
   * Where in that entrance it starts, as a CSS delay in milliseconds (zero or negative). My message is confirmed within a
   * few tens of milliseconds, mid-entrance, and the confirmed row is another element than the pending one it replaces:
   * it takes up the entrance where the pending bubble was, instead of starting over or skipping the rest.
   */
  delay: number
  /**
   * What hangs under this row (the day, the "new messages" line) came with the arrival below it: it opens at the same
   * pace, so the list is not jumped up by its height before the message has begun to rise.
   */
  after: boolean
}

/** The longest part of an entrance (the bubble's spring): after this an arrival has nothing left to show. */
const ENTRANCE_MS = springEasing(springs.bouncy).duration
/** How long a row stays marked: the entrance, with a margin for a slow frame. */
const MARKED_MS = ENTRANCE_MS + 300

const NONE: ReadonlyMap<string, RowArrival> = new Map()

const rowOf = (item: TimelineItem) => ({
  key: item.key,
  mine: item.type !== 'start' && item.who === 'me',
})

/**
 * The rows that have just arrived, by key, for as long as their entrance lasts. `live` is asked in the commit that
 * brings the rows: only a list that is already on screen and at its foot shows arrivals (what comes while the reader
 * is further up is counted on the "jump to latest" button, not animated out of sight).
 *
 * The mark is taken off again after the entrance: the list draws only the rows near the viewport, and a row that
 * scrolled away and came back must not make its entrance twice.
 */
export function useArrivals(
  items: readonly TimelineItem[],
  live: () => boolean,
): ReadonlyMap<string, RowArrival> {
  const previous = useRef<readonly TimelineItem[] | null>(null)
  /** When the entrance of each marked row began (`performance.now()`). */
  const began = useRef(new Map<string, number>())
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const isLive = useRef(live)
  const [arrivals, setArrivals] = useState(NONE)

  useLayoutEffect(() => {
    isLive.current = live
  })

  useLayoutEffect(() => {
    const before = previous.current
    previous.current = items
    if (before === null || before === items || !isLive.current()) return
    const found = arrivalsOf(before.map(rowOf), items.map(rowOf))
    if (found.size === 0) return
    const now = performance.now()
    const marked = new Map<string, RowArrival>()
    for (const [key, arrival] of found) {
      if (arrival.kind === 'new') {
        began.current.set(key, now)
        marked.set(key, { entering: true, delay: 0, after: false })
        continue
      }
      // My message, confirmed. If its pending bubble was still coming in, the entrance goes on from where that one was;
      // if that entrance was over, the confirmed row simply stands where the pending one stood.
      const start = began.current.get(arrival.from)
      if (start === undefined || now - start >= ENTRANCE_MS) continue
      began.current.set(key, start)
      marked.set(key, { entering: true, delay: Math.round(start - now), after: false })
    }
    // The row above the first newcomer: a separator it has only now (it announces the newcomer) opens with it.
    const first = items.findIndex((item) => found.get(item.key)?.kind === 'new')
    const above = first > 0 ? items[first - 1] : undefined
    if (above !== undefined && (above.after.date !== null || above.after.unread)) {
      const was = before.find((item) => item.key === above.key)
      if (was !== undefined && was.after.date === null && !was.after.unread) {
        const own = marked.get(above.key)
        marked.set(above.key, {
          entering: own?.entering ?? false,
          delay: own?.delay ?? 0,
          after: true,
        })
      }
    }
    if (marked.size === 0) return
    setArrivals((current) => new Map([...current, ...marked]))
    const timer = setTimeout(() => {
      timers.current.delete(timer)
      setArrivals((current) => {
        const next = new Map(current)
        for (const [key, arrival] of marked) {
          if (next.get(key) === arrival) next.delete(key)
          began.current.delete(key)
        }
        return next.size === 0 ? NONE : next
      })
    }, MARKED_MS)
    timers.current.add(timer)
  }, [items])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const timer of pending) clearTimeout(timer)
      pending.clear()
    }
  }, [])

  return arrivals
}
