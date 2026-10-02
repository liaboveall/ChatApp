// Entry point: reads the URL hash, builds the review frame, wires the global shortcuts, runs a scene.

import {
  applyPrefs,
  bus,
  DEFAULT_PREFS,
  isModKey,
  runtime,
  selectConversation,
  setPref,
  state,
  ui,
} from './core.js'
import { conv } from './data.js'
import { $$ } from './dom.js'
import { initNotifications } from './notifications.js'
import { initPalette } from './palette.js'
import { buildProto, runScene, SCENES, setWidth, showView } from './proto.js'
import { initSettings } from './settings.js'

// "#scene" from a shared link, or "#scene=…&theme=dark&accent=purple" for local checks.
function readHash() {
  const raw = location.hash.replace(/^#/, '')
  if (!raw) return {}
  if (!raw.includes('=')) return { scene: raw }
  return Object.fromEntries(new URLSearchParams(raw))
}

const params = readHash()
if (params.nostore) runtime.persist = false
if (params.fresh) state.prefs = { ...DEFAULT_PREFS }
const asBool = (v) => v === '1' || v === 'true'
if (params.theme) state.prefs.theme = params.theme
if (params.accent) state.prefs.accent = params.accent
if (params.glass) state.prefs.glass = params.glass
if (params.type !== undefined) state.prefs.typeSize = Number(params.type)
if (params.font) state.prefs.font = params.font
if (params.reduce) state.prefs.reduceMotion = asBool(params.reduce)
if (params.compact) state.prefs.compact = asBool(params.compact)
if (params.static) document.documentElement.classList.add('no-anim')
if (params.quiet) state.quiet = true

const root = document.getElementById('root')
buildProto(root)
applyPrefs()
initPalette()
initSettings()
initNotifications()

bus.on('view:set', (name) => {
  if (name === 'app') runScene('channel')
  else showView(name)
})

// ---- Global shortcuts (docs/02 section 7). Ctrl stands in for the command key off Apple devices. ----

function visibleConversationIds(unreadOnly) {
  return $$('.s-item', ui.sidebarEl)
    .filter((el) => !el.closest('[hidden]'))
    .filter((el) => !unreadOnly || el.dataset.unread === 'true')
    .map((el) => el.dataset.id)
}

document.addEventListener('keydown', (event) => {
  if (state.view !== 'app' || event.defaultPrevented) return
  const key = event.key.toLowerCase()
  if (isModKey(event) && key === 'k') {
    event.preventDefault()
    bus.emit('palette:open', { query: '' })
  } else if (isModKey(event) && key === 'j') {
    event.preventDefault()
    const c = conv(state.conv)
    if (c && c.kind !== 'agent')
      bus.emit('inspector:set', state.inspector === 'assistant' ? 'closed' : 'assistant')
  } else if (isModKey(event) && event.key === '/') {
    event.preventDefault()
    bus.emit('shortcuts:open')
  } else if (isModKey(event) && event.key === ',') {
    event.preventDefault()
    bus.emit('settings:open', 'appearance')
  } else if (
    event.altKey &&
    (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
    !event.isComposing
  ) {
    const ids = visibleConversationIds(event.shiftKey)
    if (ids.length === 0) return
    event.preventDefault()
    const i = ids.indexOf(state.conv)
    const step = event.key === 'ArrowDown' ? 1 : -1
    selectConversation(ids[(i + step + ids.length) % ids.length])
  }
})

setWidth(params.width ?? 'fit')
const requested = SCENES.some((s) => s.id === params.scene) ? params.scene : 'channel'
runScene(requested, { silent: true })
window.__proto = { state, ui, runScene, SCENES, bus, setPref }
document.documentElement.dataset.ready = 'true'
