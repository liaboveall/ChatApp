// The review frame around the app: a control bar (scenes, theme, accent, transparency, width, more),
// the stage the window sits in, view switching and the scene list. None of this is part of the product.

import { accents } from '../../tools/tokens.mjs'
import { buildAuthView } from './auth.js'
import { appIcon } from './brand.js'
import { bus, resetPrefs, selectConversation, setPref, state, ui } from './core.js'
import { conv, resetData } from './data.js'
import { $, h, icon, uid } from './dom.js'
import { buildNotesView, NOTE_PAGES } from './notes.js'
import { closeNotifications } from './notifications.js'
import { closeAllModals, closeMenu, initTooltips, openMenu, toast } from './overlays.js'
import { openPalette } from './palette.js'
import { buildAppView } from './shell.js'
import { appendMessage } from './timeline.js'
import { session } from './toolbar.js'
import { seg } from './widgets.js'

const WIDTHS = [
  ['fit', '自适应（铺满）'],
  ['1440', '1440 · 桌面'],
  ['1280', '1280 · 双栏加面板'],
  ['1024', '1024 · 面板变浮层'],
  ['800', '800 · 侧栏折叠'],
  ['480', '480 · 单栏'],
  ['320', '320 · 400% 缩放'],
]

let barHost = null
let currentScene = 'channel'
let stageEl = null
let barEls = {}

// ---- Views ----

export function showView(name, opts = {}) {
  closeAllModals()
  closeMenu()
  closeNotifications()
  const kind = name === 'app' ? 'app' : name === 'notes' ? 'notes' : 'auth'
  let view
  if (kind === 'app') view = buildAppView()
  else if (kind === 'notes') view = buildNotesView(opts.page)
  else view = buildAuthView(name)
  state.view = name
  ui.windowEl.dataset.view = kind
  ui.windowEl.replaceChildren(view.el)
  ui.overlayEl = view.overlay
  if (kind !== 'app') initTooltips(view.el)
  if (kind === 'app') bus.emit('app:mounted')
  view.focus?.()
  return view
}

function showEmpty() {
  showView('app')
  state.conv = null
  state.inspector = 'closed'
  bus.emit('conv', null)
  bus.emit('inspector', 'closed')
}

// ---- Scenes ----

const sceneApp =
  (id, { inspector = 'closed', after } = {}) =>
  () => {
    showView('app')
    selectConversation(id)
    state.inspector = 'closed'
    bus.emit('inspector:set', inspector)
    after?.()
  }

function sleepThen(ms, fn) {
  setTimeout(fn, ms)
}

export const SCENE_GROUPS = [
  {
    title: '登录与注册',
    scenes: [
      { id: 'login', label: '登录', run: () => showView('login') },
      { id: 'register', label: '注册（邀请码已填）', run: () => showView('register') },
      {
        id: 'register-invalid',
        label: '注册：邀请码无效',
        run: () => showView('register-invalid'),
      },
      {
        id: 'register-expired',
        label: '注册：邀请码已过期',
        run: () => showView('register-expired'),
      },
      { id: 'verify', label: '验证邮箱（可重发）', run: () => showView('verify') },
      { id: 'verify-confirm', label: '邮件链接：确认验证', run: () => showView('verify-confirm') },
      { id: 'verify-expired', label: '邮件链接：已过期', run: () => showView('verify-expired') },
      { id: 'forgot', label: '找回密码', run: () => showView('forgot') },
      { id: 'forgot-sent', label: '找回密码：已发送', run: () => showView('forgot-sent') },
      { id: 'reset', label: '重置密码', run: () => showView('reset') },
    ],
  },
  {
    title: '聊天',
    scenes: [
      { id: 'channel', label: '频道聊天（图片、回复、@提及）', run: sceneApp('ch-project') },
      { id: 'dm', label: '私信（在线状态）', run: sceneApp('dm-alice') },
      {
        id: 'group',
        label: '群组加成员面板（群主视角）',
        run: sceneApp('g-hike', { inspector: 'details' }),
      },
      {
        id: 'members',
        label: '频道：详情与成员',
        run: sceneApp('ch-project', { inspector: 'details' }),
      },
      {
        id: 'new-member',
        label: '新成员视角（历史边界）',
        run: sceneApp('ch-design', { inspector: 'assistant' }),
      },
      { id: 'empty', label: '空状态（没有选中会话）', run: showEmpty },
      {
        id: 'typing',
        label: '对方正在输入',
        run: sceneApp('ch-project', {
          after: () => (
            (state.typing = ['xuqing']), bus.emit('timeline:render', { toBottom: true })
          ),
        }),
      },
      {
        id: 'context-menu',
        label: '消息右键菜单',
        run: sceneApp('ch-project', { after: () => sleepThen(120, () => openMessageMenu('p10')) }),
      },
      {
        id: 'jump',
        label: '离开底部：回到最新',
        run: sceneApp('ch-project', { after: () => sleepThen(120, jumpDemo) }),
      },
      { id: 'states', label: '消息状态陈列', run: sceneApp('ch-states') },
      { id: 'offline', label: '断网：未同步', run: sceneApp('ch-project', { after: offlineDemo }) },
    ],
  },
  {
    title: '助手',
    scenes: [
      { id: 'agent', label: 'Agent 会话：工具卡片与审批卡片', run: sceneApp('ag-weekly') },
      { id: 'agent-new', label: '新的助手会话（示例提问）', run: sceneApp('ag-new') },
      {
        id: 'agent-stream',
        label: '流式输出（重放，深度模式）',
        run: sceneApp('ag-new', {
          after: () =>
            sleepThen(150, () => {
              session.mode = 'deep'
              bus.emit('toolbar:refresh')
              bus.emit('composer:send-text', '总结今天 #项目组 的讨论')
            }),
        }),
      },
      {
        id: 'waiting',
        label: '等待批准（重放）',
        run: sceneApp('ag-new', {
          after: () =>
            sleepThen(150, () =>
              bus.emit('composer:send-text', '在 #项目组 说一声：周五评审改到 15:00'),
            ),
        }),
      },
      {
        id: 'assistant-panel',
        label: '助手面板：总结未读',
        run: sceneApp('ch-project', {
          inspector: 'assistant',
          after: () =>
            sleepThen(200, () =>
              bus.emit('assistant:ask', { kind: 'unread', prompt: '总结这个会话的未读消息' }),
            ),
        }),
      },
      {
        id: 'assistant-all',
        label: '助手面板：切到全部会话',
        run: sceneApp('ch-project', {
          inspector: 'assistant',
          after: () => sleepThen(200, () => bus.emit('assistant:scope', 'all')),
        }),
      },
      { id: 'tasks', label: '提醒、定时消息与夏令时确认', run: sceneApp('ag-tasks') },
      { id: 'memory', label: '记忆标签与重新生成', run: sceneApp('ag-draft') },
      {
        id: 'byok-error',
        label: '自带 key 失败：改用站点额度',
        run: () => {
          session.keySource = 'user'
          sceneApp('ag-byok')()
        },
      },
    ],
  },
  {
    title: '浮层与设置',
    scenes: [
      {
        id: 'palette',
        label: '命令面板（⌘K）',
        run: sceneApp('ch-project', { after: () => sleepThen(80, () => openPalette()) }),
      },
      {
        id: 'palette-search',
        label: '命令面板：搜索消息',
        run: sceneApp('ch-project', {
          after: () => sleepThen(80, () => openPalette({ query: '迁移' })),
        }),
      },
      {
        id: 'notifications',
        label: '通知中心',
        run: sceneApp('ch-project', {
          after: () =>
            sleepThen(80, () =>
              bus.emit('notifications:toggle', ui.sidebarEl.querySelector('.bell')),
            ),
        }),
      },
      {
        id: 'settings-appearance',
        label: '设置 · 外观',
        run: sceneApp('ch-project', {
          after: () => sleepThen(80, () => bus.emit('settings:open', 'appearance')),
        }),
      },
      {
        id: 'settings-account',
        label: '设置 · 账号与设备',
        run: sceneApp('ch-project', {
          after: () => sleepThen(80, () => bus.emit('settings:open', 'account')),
        }),
      },
      {
        id: 'settings-invites',
        label: '设置 · 邀请',
        run: sceneApp('ch-project', {
          after: () => sleepThen(80, () => bus.emit('settings:open', 'invites')),
        }),
      },
      {
        id: 'settings-assistant',
        label: '设置 · 助手（用量、自带 key）',
        run: sceneApp('ch-project', {
          after: () => sleepThen(80, () => bus.emit('settings:open', 'assistant')),
        }),
      },
      {
        id: 'settings-notifications',
        label: '设置 · 通知（M6）',
        run: sceneApp('ch-project', {
          after: () => sleepThen(80, () => bus.emit('settings:open', 'notifications')),
        }),
      },
      {
        id: 'shortcuts',
        label: '快捷键帮助',
        run: sceneApp('ch-project', {
          after: () => sleepThen(80, () => bus.emit('shortcuts:open')),
        }),
      },
    ],
  },
  {
    title: '窗口宽度',
    scenes: [
      {
        id: 'w1280',
        label: '1280：双栏加面板',
        width: '1280',
        run: sceneApp('ch-project', { inspector: 'details' }),
      },
      {
        id: 'w1024',
        label: '1024：面板变浮层',
        width: '1024',
        run: sceneApp('ch-project', { inspector: 'details' }),
      },
      { id: 'w800', label: '800：侧栏折叠成窄栏', width: '800', run: sceneApp('ch-project') },
      { id: 'w480', label: '480：单栏加抽屉', width: '480', run: sceneApp('ch-project') },
      { id: 'w320', label: '320：400% 缩放', width: '320', run: sceneApp('ch-project') },
    ],
  },
  {
    title: '设计说明',
    scenes: NOTE_PAGES.map((p) => ({
      id: `notes-${p.id}`,
      label: `${p.label}（${p.hint}）`,
      run: () => showView('notes', { page: p.id }),
    })),
  },
]

export const SCENES = SCENE_GROUPS.flatMap((g) => g.scenes)

function openMessageMenu(id) {
  const el = ui.timelineEl.querySelector(`[data-msg="${id}"] .bubble`)
  if (!el) return
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  el.closest('.msg').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 80, clientY: r.top + 24 }),
  )
}

function jumpDemo() {
  ui.timelineEl.scrollTop = 0
  setTimeout(() => {
    appendMessage('ch-project', {
      id: uid('m'),
      from: 'alice',
      t: '10:44',
      text: '图标草案发在设计频道了',
    })
    appendMessage('ch-project', { id: uid('m'), from: 'bob', t: '10:45', text: '收到，我看一下' })
  }, 120)
}

function offlineDemo() {
  state.offline = true
  appendMessage('ch-project', {
    id: uid('m'),
    from: 'me',
    t: '10:44',
    text: '断网的时候写的这条，恢复后会自动发出',
    state: 'sending',
  })
  bus.emit('timeline:render', { toBottom: true })
}

export function runScene(id, { silent = false } = {}) {
  const scene = SCENES.find((s) => s.id === id) ?? SCENES.find((s) => s.id === 'channel')
  resetData()
  state.typing = null
  state.offline = false
  bus.emit('drawer:toggle', false)
  session.keySource = 'site'
  session.mode = 'fast'
  closeAllModals()
  closeMenu()
  closeNotifications()
  if (scene.width) setWidth(scene.width)
  currentScene = scene.id
  scene.run()
  if (barEls.scene) barEls.scene.querySelector('span.scene-name').textContent = scene.label
  try {
    history.replaceState(null, '', `#${scene.id}`)
  } catch {
    /* some viewers do not allow it */
  }
  if (!silent) bus.emit('scene', scene.id)
}

// ---- Width presets ----

export function setWidth(value) {
  state.width = value
  const proto = document.querySelector('.proto')
  if (!proto) return
  proto.dataset.width = value
  proto.style.setProperty('--frame-w', value === 'fit' ? '100%' : `${value}px`)
  if (barEls.width)
    barEls.width.querySelector('span.w-name').textContent = value === 'fit' ? '自适应' : `${value}`
}

// ---- Control bar ----

function menuHost() {
  return { overlayEl: barHost, boundsEl: document.documentElement }
}

function openBarMenu(anchor, event, items, label) {
  openMenu({
    anchor,
    host: menuHost(),
    focusFirst: event?.detail === 0,
    placement: 'bottom-start',
    ariaLabel: label,
    items,
    className: 'menu--scroll',
  })
}

function buildBar() {
  const scene = h(
    'button.btn.btn--tinted.btn--sm',
    {
      type: 'button',
      'aria-haspopup': 'menu',
      onclick: (e) =>
        openBarMenu(
          e.currentTarget,
          e,
          SCENE_GROUPS.flatMap((g, i) => [
            i > 0 ? { type: 'separator' } : null,
            { type: 'label', label: g.title },
            ...g.scenes.map((s) => ({
              label: s.label,
              checked: s.id === currentScene,
              onSelect: () => runScene(s.id),
            })),
          ]).filter(Boolean),
          '场景',
        ),
    },
    icon('layers', 16),
    h('span.scene-name', '频道聊天'),
    icon('chevron-down', 14),
  )
  const theme = seg({
    label: '主题',
    value: state.prefs.theme,
    items: [
      { value: 'light', icon: 'sun', label: '', title: '浅色', ariaLabel: '浅色' },
      { value: 'dark', icon: 'moon', label: '', title: '深色', ariaLabel: '深色' },
      { value: 'system', icon: 'monitor', label: '', title: '跟随系统', ariaLabel: '跟随系统' },
    ],
    onChange: (v) => setPref('theme', v),
  })
  const accent = h(
    'button.btn.btn--tinted.btn--sm',
    {
      type: 'button',
      'aria-haspopup': 'menu',
      onclick: (e) =>
        openBarMenu(
          e.currentTarget,
          e,
          Object.entries(accents).map(([key, a]) => ({
            label: a.name,
            iconNode: h('span.dot', {
              style: { '--c': `light-dark(${a.solid[0]}, ${a.solid[1]})` },
            }),
            checked: state.prefs.accent === key,
            onSelect: () => setPref('accent', key),
          })),
          '强调色',
        ),
    },
    h('span.dot', { style: { '--c': 'var(--accent-solid)' } }),
    '强调色',
    icon('chevron-down', 14),
  )
  const glassBtn = h(
    'button.btn.btn--tinted.btn--sm',
    {
      type: 'button',
      'aria-haspopup': 'menu',
      onclick: (e) =>
        openBarMenu(
          e.currentTarget,
          e,
          [
            ['clear', '清透 45%'],
            ['standard', '标准 62%'],
            ['tinted', '着色 80%'],
            ['opaque', '不透明 100%'],
          ].map(([v, l]) => ({
            label: l,
            checked: state.prefs.glass === v,
            onSelect: () => (setPref('glass', v), refreshBar()),
          })),
          '透明度',
        ),
    },
    icon('layers', 16),
    h('span.g-name', '透明度'),
    icon('chevron-down', 14),
  )
  const width = h(
    'button.btn.btn--tinted.btn--sm',
    {
      type: 'button',
      'aria-haspopup': 'menu',
      onclick: (e) =>
        openBarMenu(
          e.currentTarget,
          e,
          WIDTHS.map(([v, l]) => ({
            label: l,
            checked: state.width === v,
            onSelect: () => setWidth(v),
          })),
          '窗口宽度',
        ),
    },
    icon('monitor', 16),
    '宽度 ',
    h('span.w-name', '自适应'),
    icon('chevron-down', 14),
  )
  const more = h(
    'button.btn.btn--tinted.btn--sm',
    {
      type: 'button',
      'aria-haspopup': 'menu',
      onclick: (e) => openBarMenu(e.currentTarget, e, moreItems(), '更多'),
    },
    '更多',
    icon('chevron-down', 14),
  )
  const counter = h('span.proto__count', { 'aria-live': 'off' })
  barEls = { scene, theme, accent, glass: glassBtn, width, more, counter }
  return h(
    'div.proto__bar',
    { role: 'toolbar', 'aria-label': '原型控制台' },
    h(
      'div.proto__brand',
      appIcon('a', 26),
      h('b', 'ChatApp'),
      h('span.badge.badge--role', 'D 设计原型'),
    ),
    scene,
    theme,
    accent,
    glassBtn,
    width,
    more,
    h('span.proto__spacer'),
    counter,
  )
}

function moreItems() {
  const p = state.prefs
  return [
    { type: 'label', label: '字体（D1 对比）' },
    { label: '系统字体', checked: p.font === 'system', onSelect: () => setPref('font', 'system') },
    {
      label: 'Inter（已内嵌）',
      checked: p.font === 'inter',
      onSelect: () => setPref('font', 'inter'),
    },
    { type: 'label', label: '界面字号' },
    ...[-1, 0, 1, 2, 3].map((v) => ({
      label: v === 0 ? '默认' : `${v > 0 ? '+' : ''}${v} 档`,
      checked: p.typeSize === v,
      onSelect: () => setPref('typeSize', v),
    })),
    { type: 'separator' },
    {
      label: p.reduceMotion ? '关闭「减少动态效果」' : '开启「减少动态效果」',
      icon: 'zap',
      onSelect: () => setPref('reduceMotion', !p.reduceMotion),
    },
    {
      label: p.compact ? '侧栏显示消息预览' : '侧栏隐藏消息预览',
      icon: 'panel-left',
      onSelect: () => setPref('compact', !p.compact),
    },
    { type: 'separator' },
    { type: 'label', label: '模拟事件' },
    {
      label: '来一条新消息',
      icon: 'message-circle',
      onSelect: () =>
        appendMessage(state.conv ?? 'ch-project', {
          id: uid('m'),
          from: 'alice',
          t: '10:46',
          text: '收到，我现在发给你',
        }),
    },
    {
      label: state.typing ? '对方不再输入' : '对方正在输入',
      icon: 'pencil',
      onSelect: () => (
        (state.typing = state.typing ? null : ['xuqing']),
        bus.emit('timeline:render', { toBottom: true })
      ),
    },
    {
      label: state.offline ? '恢复网络' : '断开网络',
      icon: 'wifi-off',
      onSelect: () => (
        (state.offline = !state.offline),
        bus.emit('timeline:render', { toBottom: true }),
        toast(state.offline ? '网络已断开，发出的消息会显示未同步' : '已恢复，正在同步')
      ),
    },
    { label: '重置数据', icon: 'rotate-ccw', onSelect: () => runScene(currentScene) },
    {
      label: '恢复默认外观',
      icon: 'eraser',
      onSelect: () => (resetPrefs(), refreshBar(), toast('已恢复默认外观')),
    },
    { type: 'separator' },
    { label: '设计说明：玻璃对照板', icon: 'layers', onSelect: () => runScene('notes-glass') },
  ]
}

function refreshBar() {
  barEls.theme?.set(state.prefs.theme)
  const names = { clear: '清透', standard: '标准', tinted: '着色', opaque: '不透明' }
  if (barEls.glass) barEls.glass.querySelector('span.g-name').textContent = names[state.prefs.glass]
}

function countBackdrops() {
  let n = 0
  for (const el of ui.windowEl.querySelectorAll('*')) {
    const cs = getComputedStyle(el)
    const f = cs.backdropFilter || cs.webkitBackdropFilter
    if (f && f !== 'none') n += 1
  }
  return n
}

function tick() {
  if (!barEls.counter) return
  const w = ui.windowEl.getBoundingClientRect().width
  barEls.counter.textContent = `窗口 ${Math.round(w)} px · 玻璃层 ${countBackdrops()}/4`
}

export function buildProto(root) {
  const bar = buildBar()
  barHost = h('div.overlay.proto__overlay', { style: { zIndex: '3000' } })
  ui.windowEl = h('div.window', { dataset: { view: 'app' } })
  stageEl = h('div.proto__stage', ui.windowEl)
  const proto = h(
    'div.proto',
    { dataset: { width: 'fit' } },
    h(
      'a.skip-link',
      {
        href: '#main',
        onclick: (e) => (e.preventDefault(), document.getElementById('main')?.focus()),
      },
      '跳到主要内容',
    ),
    bar,
    stageEl,
    barHost,
    h('div#live-region.sr-only', { 'aria-live': 'polite', role: 'status' }),
  )
  root.replaceChildren(proto)
  initTooltips(proto)
  setInterval(tick, 1500)
  bus.on('prefs', () => refreshBar())
  window.addEventListener('resize', tick)
  return proto
}

export { $, conv }
