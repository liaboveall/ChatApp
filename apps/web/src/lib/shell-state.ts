/**
 * Layout state of the app shell: which Inspector tab is open, whether the navigation drawer is open (narrow windows),
 * and the sidebar width, which is the only part remembered between visits (per device).
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

function loadSidebarWidth(): number {
  const raw = local.get(LAYOUT_KEY)
  if (raw === null) return SIDEBAR_DEFAULT
  try {
    const value = (JSON.parse(raw) as { sidebarWidth?: unknown }).sidebarWidth
    return typeof value === 'number' ? clampSidebar(value) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

type ShellState = {
  /** null: the Inspector is closed. */
  inspector: InspectorTab | null
  drawerOpen: boolean
  sidebarWidth: number
  setInspector: (tab: InspectorTab | null) => void
  /** ⌘J: opens the assistant tab, or closes the Inspector when it already shows it. */
  toggleAssistant: () => void
  setDrawer: (open: boolean) => void
  setSidebarWidth: (width: number, persist?: boolean) => void
}

export const useShell = create<ShellState>()((set, get) => ({
  inspector: null,
  drawerOpen: false,
  sidebarWidth: loadSidebarWidth(),
  setInspector: (tab) => set({ inspector: tab }),
  toggleAssistant: () => set({ inspector: get().inspector === 'assistant' ? null : 'assistant' }),
  setDrawer: (open) => set({ drawerOpen: open }),
  setSidebarWidth: (width, persist = true) => {
    const next = clampSidebar(width)
    set({ sidebarWidth: next })
    if (persist) local.set(LAYOUT_KEY, JSON.stringify({ sidebarWidth: next }))
  },
}))
