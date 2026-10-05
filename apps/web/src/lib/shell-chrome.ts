/**
 * What the current screen puts into the toolbar (D-156): a title, a subtitle, an avatar and whether the "members" button
 * shows. The screen writes it while it is mounted and the toolbar reads it; leaving the screen restores the default. Plain
 * data on purpose: an object of strings and flags can be compared by value, so a screen that re-renders does not rewrite
 * the toolbar each time.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import type { PresenceStatus } from '@/components/ui/avatar.tsx'

export type ToolbarAvatar = {
  name: string
  seed: string
  /** A channel shows a hash sign instead of an initial. */
  glyph?: 'hash' | undefined
  status?: PresenceStatus | undefined
}

export type ToolbarContent = {
  title: string
  subtitle: string | null
  avatar: ToolbarAvatar | null
  /** The button that opens the conversation's details in the Inspector. */
  members: boolean
}

type ChromeState = {
  content: ToolbarContent | null
  set: (content: ToolbarContent | null) => void
}

export const useChrome = create<ChromeState>()((set) => ({
  content: null,
  set: (content) => set({ content }),
}))

/** Shows `content` in the toolbar while the calling screen is mounted. */
export function useToolbarContent(content: ToolbarContent | null): void {
  const set = useChrome((state) => state.set)
  const key = content === null ? '' : JSON.stringify(content)
  useEffect(() => {
    set(key === '' ? null : (JSON.parse(key) as ToolbarContent))
    return () => set(null)
  }, [key, set])
}
