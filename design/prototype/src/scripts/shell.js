// Builds the app view (wallpaper, sidebar, main column, inspector, overlay layer) and wires the
// modules that draw into it.

import { initAgent } from './agent.js'
import { initComposer } from './composer.js'
import { bus, state, ui } from './core.js'
import { h, rememberFocus } from './dom.js'
import { initInspector, renderInspector } from './inspector.js'
import { initTooltips } from './overlays.js'
import { initSidebar, renderSidebar } from './sidebar.js'
import { initTimeline, renderTimeline } from './timeline.js'
import { initToolbar, renderToolbar } from './toolbar.js'

let built = null

export function buildAppView() {
  if (built) return built
  const wallpaper = h(
    'div.wallpaper',
    { 'aria-hidden': 'true' },
    h('div.orb.orb--a'),
    h('div.orb.orb--b'),
    h('div.orb.orb--c'),
    h('div.orb.orb--d'),
  )
  const sidebar = h('nav.sidebar.glass.squircle', { 'aria-label': '会话' })
  const splitter = h('div.splitter', {
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': '调整侧栏宽度，左右方向键移动',
    'aria-valuemin': '240',
    'aria-valuemax': '360',
    'aria-valuenow': String(state.prefs.sidebarW),
    tabindex: '0',
  })
  const toolbar = h('header.toolbar')
  const timeline = h(
    'div.timeline.scroll',
    { id: 'timeline', tabindex: '-1', 'aria-label': '消息列表' },
    h('div.timeline__inner'),
  )
  const composerSlot = h('div.composer-slot')
  const main = h('main.main.squircle#main', { tabindex: '-1' }, toolbar, timeline, composerSlot)
  const inspector = h('aside.inspector.squircle', { 'aria-label': '会话详情与助手' })
  // The scrim lives inside .app: .app is a stacking context, so a sibling scrim would sit above the drawer.
  const scrim = h('div.drawer-scrim', { onclick: () => bus.emit('drawer:toggle', false) })
  const app = h(
    'div.app',
    { dataset: { inspector: 'closed', drawer: 'closed' } },
    sidebar,
    splitter,
    main,
    inspector,
    scrim,
  )
  const overlay = h('div.overlay')
  const el = h('div', { style: { position: 'absolute', inset: '0' } }, wallpaper, app, overlay)

  Object.assign(ui, {
    appEl: app,
    sidebarEl: sidebar,
    splitterEl: splitter,
    mainEl: main,
    toolbarEl: toolbar,
    timelineEl: timeline,
    composerSlotEl: composerSlot,
    inspectorEl: inspector,
  })
  built = { el, overlay, app }
  ui.windowEl.style.setProperty('--sidebar-w', `${state.prefs.sidebarW}px`)
  // The overlay must exist in `ui` before the modules draw: they open menus into it.
  ui.overlayEl = overlay
  initTooltips(el)

  initSidebar()
  initTimeline()
  initToolbar()
  initInspector()
  initAgent()
  initComposer()

  let restoreDrawer = null
  bus.on('drawer:toggle', (force) => {
    const next = typeof force === 'boolean' ? force : !state.drawer
    if (next === state.drawer) return
    state.drawer = next
    app.dataset.drawer = next ? 'open' : 'closed'
    if (next) {
      restoreDrawer = rememberFocus()
      sidebar.querySelector('.s-item[tabindex="0"]')?.focus({ preventScroll: true })
    } else {
      restoreDrawer?.()
      restoreDrawer = null
    }
  })
  bus.on('conv', () => {
    if (state.drawer) bus.emit('drawer:toggle', false)
  })
  sidebar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.drawer) bus.emit('drawer:toggle', false)
  })

  renderSidebar()
  renderToolbar()
  renderTimeline()
  renderInspector()
  return built
}
