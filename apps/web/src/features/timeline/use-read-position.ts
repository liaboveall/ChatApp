/**
 * When to move the person's read position forward (docs/01 section 4.7, D-152). Only when three things are true at once
 * and stay true for a short while: the page is in front, the window reaches the newest message, and the list is scrolled
 * to the bottom. Reading history further up does not count as having read the newest messages. The pause keeps a fast
 * scroll, or a screen reader walking through the list, from sending a request for every frame.
 */
import { useEffect } from 'react'
import { engine } from '@/app/sync.ts'

export const READ_AFTER_MS = 400

export function useReadPosition(input: {
  conversationId: string
  /** The newest message the server has (a message still being sent does not count). */
  newestSeq: number | null
  attached: boolean
  atBottom: boolean
  /** The list has been placed (opened at the right spot); until then "at the bottom" is not a fact about the reader. */
  placed: boolean
}): void {
  const { conversationId, newestSeq, attached, atBottom, placed } = input
  useEffect(() => {
    if (!placed || !attached || !atBottom || newestSeq === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (document.visibilityState !== 'visible') return
      timer = setTimeout(() => engine.markRead(conversationId, newestSeq), READ_AFTER_MS)
    }
    arm()
    // Back in front: the three conditions hold again, so the pause starts over.
    const onVisibility = (): void => arm()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [conversationId, newestSeq, attached, atBottom, placed])
}
