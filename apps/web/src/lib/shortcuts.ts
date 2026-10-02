/**
 * Global keyboard shortcuts (docs/02 section 7). `matchShortcut` is a pure function so the rules can be tested without a
 * browser; `useGlobalShortcuts` attaches it to the window. ⌘ on Apple platforms is Ctrl elsewhere. None of the shortcuts
 * is a browser-reserved combination (⌘N, ⌘T, ⌘W cannot be intercepted by a page, D-052); whether the others reach the
 * page in every browser is V-16 and is verified by hand per browser (docs/12).
 */
import { useEffect } from 'react'
import { isApplePlatform } from './platform.ts'

export type ShortcutId = 'palette' | 'assistant' | 'settings' | 'help'

export type ShortcutDef = {
  id: ShortcutId
  keys: string[]
  /** `event.key` values (lower-case) and the physical key as fallback for non-Latin layouts. */
  key: string
  code: string
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'palette', keys: ['mod', 'K'], key: 'k', code: 'KeyK' },
  { id: 'assistant', keys: ['mod', 'J'], key: 'j', code: 'KeyJ' },
  { id: 'settings', keys: ['mod', ','], key: ',', code: 'Comma' },
  { id: 'help', keys: ['mod', '/'], key: '/', code: 'Slash' },
]

type KeyEventLike = Pick<
  KeyboardEvent,
  | 'key'
  | 'code'
  | 'ctrlKey'
  | 'metaKey'
  | 'altKey'
  | 'shiftKey'
  | 'isComposing'
  | 'defaultPrevented'
>

const isLatinKey = (key: string): boolean => /^[\x20-\x7e]$/.test(key)

/** Which shortcut (if any) a key event is. Never matches while an IME is composing or when something already handled it. */
export function matchShortcut(event: KeyEventLike, apple = isApplePlatform()): ShortcutId | null {
  if (event.isComposing || event.defaultPrevented) return null
  const mod = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod || event.altKey || event.shiftKey) return null
  const key = event.key.toLowerCase()
  for (const shortcut of SHORTCUTS) {
    if (isLatinKey(key) ? key === shortcut.key : event.code === shortcut.code) return shortcut.id
  }
  return null
}

/** Calls `handlers[id]` for the matching shortcut and cancels the browser's own action for it. */
export function useGlobalShortcuts(handlers: Partial<Record<ShortcutId, () => void>>): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const id = matchShortcut(event)
      const handler = id ? handlers[id] : undefined
      if (!handler) return
      event.preventDefault()
      handler()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handlers])
}
