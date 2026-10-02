// Shared state, preferences, the event bus and the element registry.

import { conv } from './data.js'
import { store } from './dom.js'

const PREFS_STORE = 'chatapp-d-prefs-v1'

export const DEFAULT_PREFS = {
  theme: 'system', // system | light | dark
  accent: 'blue',
  glass: 'standard', // clear | standard | tinted | opaque
  typeSize: 0, // -1 .. +3
  reduceMotion: false,
  compact: false, // sidebar without message previews
  font: 'system', // system | inter (D1 comparison)
  sidebarW: 280,
}

export const state = {
  prefs: { ...DEFAULT_PREFS, ...(store(PREFS_STORE) ?? {}) },
  view: 'app', // app | login | register | verify | verify-confirm | forgot | forgot-sent | reset | notes
  notesPage: 'principles',
  conv: 'ch-project',
  inspector: 'closed', // closed | details | assistant
  drawer: false,
  width: 'fit', // review width preset
  offline: false,
  newMemberView: false,
  typing: null,
  auth: null,
  quiet: false, // no simulated replies (used by the automated checks)
}

export const ui = {}

/** persist: write preferences to localStorage (off when the URL asks for a clean run). */
export const runtime = { persist: true }

const listeners = {}
export const bus = {
  on(type, fn) {
    ;(listeners[type] ??= new Set()).add(fn)
    return () => listeners[type].delete(fn)
  },
  emit(type, detail) {
    for (const fn of listeners[type] ?? []) fn(detail)
  },
}

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Key caps as shown to the user: ⌘ ⌥ ⇧ on Apple devices, Ctrl Alt Shift elsewhere (spec 7). */
export function keycap(key) {
  if (IS_MAC) return key
  return { '⌘': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' }[key] ?? key
}

export const isModKey = (event) => event.metaKey || event.ctrlKey

/** A shortcut as text: "⌘K" on Apple devices, "Ctrl K" elsewhere. */
export function shortcut(...keys) {
  return IS_MAC ? keys.map(keycap).join('') : keys.map(keycap).join(' ')
}

// ---- Preferences ----

const root = document.documentElement
// The artifact viewer may set data-theme itself. "Follow system" in the app means: keep what the host chose.
let hostTheme = root.getAttribute('data-theme')
// What this module last wrote. MutationObserver callbacks run later (as microtasks), so a flag set around
// our own write would already be cleared; comparing values is what tells our write from the host's.
let ours = hostTheme

export function applyTheme() {
  const pref = state.prefs.theme
  const want = pref === 'system' ? hostTheme : pref
  ours = want
  if (want) root.setAttribute('data-theme', want)
  else root.removeAttribute('data-theme')
}

new MutationObserver(() => {
  const now = root.getAttribute('data-theme')
  if (now === ours) return
  hostTheme = now
  ours = now
  if (state.prefs.theme !== 'system') applyTheme()
}).observe(root, { attributes: true, attributeFilter: ['data-theme'] })

export function applyPrefs() {
  const p = state.prefs
  applyTheme()
  root.setAttribute('data-accent', p.accent)
  root.setAttribute('data-glass', p.glass)
  if (p.typeSize === 0) root.removeAttribute('data-type-size')
  else root.setAttribute('data-type-size', String(p.typeSize))
  root.setAttribute('data-font', p.font)
  root.classList.toggle('reduce-motion', p.reduceMotion)
  if (ui.windowEl) ui.windowEl.style.setProperty('--sidebar-w', `${p.sidebarW}px`)
}

export function setPref(key, value) {
  state.prefs[key] = value
  if (runtime.persist) store(PREFS_STORE, state.prefs)
  applyPrefs()
  bus.emit('prefs', { key, value })
}

export function resetPrefs() {
  state.prefs = { ...DEFAULT_PREFS }
  if (runtime.persist) store(PREFS_STORE, state.prefs)
  applyPrefs()
  bus.emit('prefs', { key: '*' })
}

export const systemReducedTransparency = () =>
  matchMedia('(prefers-reduced-transparency: reduce)').matches
export const systemReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Opens a conversation: clears its unread state and tells every view. */
export function selectConversation(id) {
  const c = conv(id)
  if (!c) return
  c.unread = 0
  c.mention = false
  state.view = 'app'
  state.conv = id
  bus.emit('conv', id)
}
