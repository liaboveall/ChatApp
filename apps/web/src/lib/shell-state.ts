/**
 * Layout state of the app shell: which Inspector tab is open, whether the navigation drawer is open (narrow windows),
 * and, remembered between visits on this device (docs/01 section 4.11), the sidebar width and which sidebar groups the
 * person has folded.
 */
import { create } from 'zustand'
import { local } from './storage.ts'

export const SIDEBAR_MIN = 240
export const SIDEBAR_MAX = 360
export const SIDEBAR_DEFAULT = 280
const LAYOUT_KEY = 'chatapp.layout'

export type InspectorTab = 'details' | 'assistant'

export const clampSidebar = (width: number): number =>
  Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)))

type StoredLayout = { sidebarWidth?: unknown; folded?: unknown }

function loadLayout(): { sidebarWidth: number; folded: Record<string, true> } {
  const fallback = { sidebarWidth: SIDEBAR_DEFAULT, folded: {} }
  const raw = local.get(LAYOUT_KEY)
  if (raw === null) return fallback
  try {
    const stored = JSON.parse(raw) as StoredLayout
    const folded: Record<string, true> = {}
    if (Array.isArray(stored.folded)) {
      for (const key of stored.folded) if (typeof key === 'string') folded[key] = true
    }
    return {
      sidebarWidth:
        typeof stored.sidebarWidth === 'number'
          ? clampSidebar(stored.sidebarWidth)
          : SIDEBAR_DEFAULT,
      folded,
    }
  } catch {
    return fallback
  }
}

function saveLayout(sidebarWidth: number, folded: Record<string, true>): void {
  local.set(LAYOUT_KEY, JSON.stringify({ sidebarWidth, folded: Object.keys(folded) }))
}

type ShellState = {
  /** null: the Inspector is closed. */
  inspector: InspectorTab | null
  drawerOpen: boolean
  sidebarWidth: number
  /** Sidebar groups the person folded, by group key. */
  folded: Record<string, true>
  toggleFolded: (group: string) => void
  setInspector: (tab: InspectorTab | null) => void
  /** ⌘J: opens the assistant tab, or closes the Inspector when it already shows it. */
  toggleAssistant: () => void
  setDrawer: (open: boolean) => void
  setSidebarWidth: (width: number, persist?: boolean) => void
}

const initial = loadLayout()

export const useShell = create<ShellState>()((set, get) => ({
  inspector: null,
  drawerOpen: false,
  sidebarWidth: initial.sidebarWidth,
  folded: initial.folded,
  toggleFolded: (group) => {
    const { folded, sidebarWidth } = get()
    const next = { ...folded }
    if (group in next) delete next[group]
    else next[group] = true
    set({ folded: next })
    saveLayout(sidebarWidth, next)
  },
  setInspector: (tab) => set({ inspector: tab }),
  toggleAssistant: () => set({ inspector: get().inspector === 'assistant' ? null : 'assistant' }),
  setDrawer: (open) => set({ drawerOpen: open }),
  setSidebarWidth: (width, persist = true) => {
    const next = clampSidebar(width)
    set({ sidebarWidth: next })
    if (persist) saveLayout(next, get().folded)
  },
}))
