/**
 * Motion that a stylesheet cannot start by itself (docs/02 section 4.5): something moves once because of what the person
 * just did (the arrow leaves the send button, a field shakes its head at a wrong password), or the whole window changes
 * its colours. Everything here does nothing where movement is off, so callers never have to ask first.
 */
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { type SpringKey, springEasing, springs, timing } from '@/design/tokens.ts'

/**
 * Whether movement is off: the system asks for less of it, the person turned it off in Settings (docs/01 section 4.10), or
 * a test froze the page (`data-no-anim`, the attribute the stylesheet also reads).
 */
export function motionOff(): boolean {
  if (typeof document === 'undefined') return true
  const root = document.documentElement
  return (
    root.getAttribute('data-reduce-motion') === 'true' ||
    root.getAttribute('data-no-anim') === 'true' ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  )
}

const curves = new Map<SpringKey, { duration: number; easing: string }>()

/** One of the three springs (docs/02 section 4.5) as the duration and `linear()` easing the stylesheet uses. */
export function spring(key: SpringKey): { duration: number; easing: string } {
  let curve = curves.get(key)
  if (curve === undefined) {
    curve = springEasing(springs[key])
    curves.set(key, curve)
  }
  return curve
}

/** The curve of what fades, blurs or leaves. */
export const SOFT = timing.soft

/** Plays keyframes once on an element (Web Animations). Nothing happens where movement is off, or without the element. */
export function play(
  element: Element | null | undefined,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation | undefined {
  if (element === null || element === undefined || motionOff()) return undefined
  if (typeof element.animate !== 'function') return undefined
  return element.animate(keyframes, options)
}

// Opacity and movement only: an animated `filter` on text over a backdrop-filtered pane crashes WebKit (motion.css).
const TICK: Keyframe[] = [
  { opacity: 0, translate: '0 0.4em' },
  { opacity: 1, translate: '0 0' },
]
const POP: Keyframe[] = [
  { opacity: 0, scale: 0.6 },
  { opacity: 1, scale: 1 },
]

/**
 * One thing takes the place of another in the same spot (a count, the last line of a conversation): the element with the
 * returned ref ticks over whenever `value` changes while it is on screen. Not when it first appears, and not when the
 * list it is in is put in another order: a row that only moved has nothing new to say. (That is why this is not a
 * keyed element with a CSS animation: re-ordering moves the nodes, and a moved node starts its CSS animations again.)
 */
export function useTick<T extends Element>(value: unknown): RefObject<T | null> {
  const ref = useRef<T>(null)
  const seen = useRef(value)
  useLayoutEffect(() => {
    if (Object.is(seen.current, value)) return
    seen.current = value
    play(ref.current, TICK, { duration: timing.swap, easing: SOFT })
  }, [value])
  return ref
}

/**
 * A small thing that was not there a moment ago (the first unread count of a conversation): the element with the
 * returned ref pops in when `present` becomes true while its owner is on screen. What is already there when the owner
 * is first drawn does not move.
 */
export function usePop<T extends Element>(present: boolean): RefObject<T | null> {
  const ref = useRef<T>(null)
  const was = useRef(present)
  useLayoutEffect(() => {
    if (was.current === present) return
    was.current = present
    if (!present) return
    const { duration, easing } = spring('bouncy')
    play(ref.current, POP, { duration, easing })
  }, [present])
  return ref
}

/** "No": a short shake of the head, for an answer that was refused (a wrong password). */
export function shake(element: Element | null | undefined): void {
  play(
    element,
    [0, -9, 8, -6, 4, -2, 0].map((x) => ({ translate: `${x}px 0` })),
    { duration: 420, easing: 'cubic-bezier(0.3, 0.6, 0.4, 1)' },
  )
}

/** Where the pointer last went down, and when (`performance.now()`). */
let pressed: { x: number; y: number; at: number } | null = null
/** A change that follows a press within this long was caused by it. */
const PRESS_FRESH_MS = 1000

/**
 * Remembers where the pointer last went down, so that a change of the whole window can spread from that point (`repaint`).
 * Returns the function that stops it.
 */
export function watchPointer(): () => void {
  const onDown = (event: PointerEvent): void => {
    pressed = { x: event.clientX, y: event.clientY, at: performance.now() }
  }
  document.addEventListener('pointerdown', onDown, { capture: true, passive: true })
  return () => document.removeEventListener('pointerdown', onDown, { capture: true })
}

let repaints = 0

/**
 * Changes the look of the whole window (the theme, the accent, the glass) as one picture giving way to another
 * (a view transition), not as hundreds of colours switching in the same frame. `reveal`: the new look spreads in a
 * circle from where the pointer was pressed, when a press caused the change; otherwise, and with reduced motion, the
 * two pictures cross-fade. Where view transitions are missing, or a test froze the page, the change is simply made.
 */
export function repaint(update: () => void, style: 'reveal' | 'fade' = 'reveal'): void {
  const root = document.documentElement
  if (
    typeof document.startViewTransition !== 'function' ||
    root.getAttribute('data-no-anim') === 'true'
  ) {
    update()
    return
  }
  const from = pressed !== null && performance.now() - pressed.at < PRESS_FRESH_MS ? pressed : null
  const reveal = style === 'reveal' && from !== null && !motionOff()
  if (reveal) {
    const radius = Math.hypot(
      Math.max(from.x, window.innerWidth - from.x),
      Math.max(from.y, window.innerHeight - from.y),
    )
    root.style.setProperty('--repaint-x', `${from.x}px`)
    root.style.setProperty('--repaint-y', `${from.y}px`)
    root.style.setProperty('--repaint-r', `${Math.ceil(radius)}px`)
  }
  root.setAttribute('data-repaint', reveal ? 'reveal' : 'fade')
  repaints += 1
  const mine = repaints
  const transition = document.startViewTransition(() => {
    flushSync(update)
  })
  // A later repaint skips this one: only the last one tidies up.
  const done = (): void => {
    if (mine !== repaints) return
    root.removeAttribute('data-repaint')
    for (const name of ['--repaint-x', '--repaint-y', '--repaint-r'])
      root.style.removeProperty(name)
  }
  transition.finished.then(done, done)
  // The update still ran if the transition could not start (a hidden tab): nothing else to do.
  transition.ready.catch(() => undefined)
}
