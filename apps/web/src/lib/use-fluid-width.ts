import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { play, spring } from './motion.ts'

/**
 * A pane that is as wide as what it holds (the toolbar's title capsule) changes shape when its content changes instead of
 * jumping to the new size (docs/02 section 4.5): the width it had flows into the width it needs, with the smooth
 * spring. `content` names what is inside; the width is only animated when that changes, never when the window does.
 *
 * The element may be a different one after the change (a button where there was a plain box): the new one starts from
 * the width the old one had, since it stands in the same place.
 */
export function useFluidWidth(ref: RefObject<HTMLElement | null>, content: string): void {
  /** The width last seen on screen, kept current by the observer (so a change that interrupts another starts mid-way). */
  const seen = useRef<number | null>(null)
  const watched = useRef<HTMLElement | null>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const running = useRef<Animation | undefined>(undefined)

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const created = new ResizeObserver(() => {
      if (watched.current !== null) seen.current = watched.current.getBoundingClientRect().width
    })
    observer.current = created
    if (watched.current !== null) created.observe(watched.current)
    return () => {
      created.disconnect()
      observer.current = null
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when what the pane holds changes, which is what resizes it
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (watched.current !== element) {
      if (watched.current !== null) observer.current?.unobserve(watched.current)
      observer.current?.observe(element)
      watched.current = element
    }
    running.current?.cancel()
    const from = seen.current
    const to = element.getBoundingClientRect().width
    seen.current = to
    if (from === null || Math.abs(from - to) < 1) return
    const { duration, easing } = spring('smooth')
    running.current = play(element, [{ width: `${from}px` }, { width: `${to}px` }], {
      duration,
      easing,
    })
  }, [content])
}
