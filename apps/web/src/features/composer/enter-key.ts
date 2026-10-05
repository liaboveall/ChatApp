/**
 * Whether an Enter key press should send the message (docs/01 section 4.5, D-050, D-154). While an input method is
 * composing (Chinese, Japanese, Korean), Enter only confirms the candidate: it must not send. Browsers differ in how they
 * say so: Chromium sets `isComposing` and the legacy key code 229; Safari ends the composition *before* it delivers the
 * confirming Enter, so `isComposing` is already false then, and only the time since `compositionend` gives it away.
 */

/** Safari delivers the confirming Enter within a few milliseconds of `compositionend`; this window covers it. */
export const COMPOSITION_END_GRACE_MS = 40

export type EnterKeyEvent = {
  key: string
  shiftKey: boolean
  /** Alt, Ctrl and Meta: Enter with them is not "send". */
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  isComposing: boolean
  keyCode: number
}

export type CompositionState = {
  /** Between `compositionstart` and `compositionend`. */
  composing: boolean
  /** When the last composition ended (milliseconds on any monotonic clock, the same one passed as `now`). */
  endedAt: number
}

export const initialComposition = (): CompositionState => ({
  composing: false,
  endedAt: Number.NEGATIVE_INFINITY,
})

export function shouldSend(event: EnterKeyEvent, state: CompositionState, now: number): boolean {
  if (event.key !== 'Enter') return false
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
  if (event.isComposing || event.keyCode === 229) return false
  if (state.composing) return false
  return now - state.endedAt >= COMPOSITION_END_GRACE_MS
}
