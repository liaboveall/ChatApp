/**
 * Appearance preferences (docs/01 section 4.10): theme, accent, glass level, type size, reduced motion. They are per
 * device, stored in localStorage and applied as attributes on <html> (tokens-css.ts keys off those attributes).
 * `public/theme-init.js` applies the stored values before the first paint and has to stay in step with `applyToRoot`;
 * a unit test compares the two.
 */

import { z } from 'zod'
import { create } from 'zustand'
import {
  ACCENT_KEYS,
  type AccentKey,
  DEFAULT_ACCENT,
  DEFAULT_GLASS,
  GLASS_KEYS,
  type GlassLevelKey,
} from '@/design/tokens.ts'
import { local } from './storage.ts'

export const APPEARANCE_STORAGE_KEY = 'chatapp.appearance'

export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export const appearanceSchema = z.object({
  theme: z.enum(THEMES).catch('system'),
  accent: z.enum(ACCENT_KEYS).catch(DEFAULT_ACCENT),
  glass: z.enum(GLASS_KEYS).catch(DEFAULT_GLASS),
  typeSize: z.number().int().min(-1).max(3).catch(0),
  reduceMotion: z.boolean().catch(false),
  compactSidebar: z.boolean().catch(false),
})
export type Appearance = z.infer<typeof appearanceSchema>

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  accent: DEFAULT_ACCENT,
  glass: DEFAULT_GLASS,
  typeSize: 0,
  reduceMotion: false,
  compactSidebar: false,
}

export function loadAppearance(): Appearance {
  const raw = local.get(APPEARANCE_STORAGE_KEY)
  if (raw === null) return DEFAULT_APPEARANCE
  try {
    return appearanceSchema.parse(JSON.parse(raw))
  } catch {
    return DEFAULT_APPEARANCE
  }
}

/** Sets the attributes the stylesheet reads. Defaults leave the attribute off so the CSS defaults apply. */
export function applyToRoot(
  appearance: Appearance,
  root: HTMLElement = document.documentElement,
): void {
  const set = (name: string, value: string | null): void => {
    if (value === null) root.removeAttribute(name)
    else root.setAttribute(name, value)
  }
  set('data-theme', appearance.theme === 'system' ? null : appearance.theme)
  set('data-accent', appearance.accent === DEFAULT_ACCENT ? null : appearance.accent)
  set('data-glass', appearance.glass === DEFAULT_GLASS ? null : appearance.glass)
  set('data-type-size', appearance.typeSize === 0 ? null : String(appearance.typeSize))
  set('data-reduce-motion', appearance.reduceMotion ? 'true' : null)
}

type AppearanceStore = Appearance & {
  set: <K extends keyof Appearance>(key: K, value: Appearance[K]) => void
  reset: () => void
}

export const useAppearance = create<AppearanceStore>()((set) => ({
  ...loadAppearance(),
  set: (key, value) => set({ [key]: value } as Pick<Appearance, typeof key>),
  reset: () => set({ ...DEFAULT_APPEARANCE }),
}))

function snapshot(state: AppearanceStore): Appearance {
  return {
    theme: state.theme,
    accent: state.accent,
    glass: state.glass,
    typeSize: state.typeSize,
    reduceMotion: state.reduceMotion,
    compactSidebar: state.compactSidebar,
  }
}

/** Applies the stored appearance and keeps <html> and storage in step with the store. Returns the unsubscribe. */
export function startAppearance(): () => void {
  applyToRoot(snapshot(useAppearance.getState()))
  return useAppearance.subscribe((state) => {
    const next = snapshot(state)
    applyToRoot(next)
    local.set(APPEARANCE_STORAGE_KEY, JSON.stringify(next))
  })
}

export type { AccentKey, GlassLevelKey }
