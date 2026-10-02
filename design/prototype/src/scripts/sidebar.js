// Sidebar (docs/02 section 3): search, pinned, channels, groups, DMs, assistant sessions, user card.

import { bus, selectConversation, shortcut, state, ui } from './core.js'
import { conv, conversations, convTitle, notifications, people } from './data.js'
import { $$, clamp, h, icon } from './dom.js'
import { openDialog, openMenu, toast } from './overlays.js'
import { avatar, badge, button, convAvatar, iconButton, presenceLabel } from './widgets.js'

const SECTIONS = [
  { id: 'pinned', label: '置顶', pick: (c) => c.pinned },
  {
    id: 'channels',
    label: '频道',
    pick: (c) => c.kind === 'channel' && !c.pinned,
    add: '新建频道',
    more: true,
  },
  {
    id: 'groups',
    label: '群组',
    pick: (c) => c.kind === 'group' && !c.pinned,
    add: '新建群组',
    more: true,
  },
  { id: 'dms', label: '私信', pick: (c) => c.kind === 'dm' && !c.pinned, add: '发起私信' },
  { id: 'agents', label: '助手', pick: (c) => c.kind === 'agent', add: '新的助手会话' },
]

const collapsed = new Set()

function itemLabel(c) {
  const parts = [convTitle(c)]
  if (c.kind === 'dm') parts.push(presenceLabel(people[c.person].status))
  if (c.unread) parts.push(`${c.unread} 条未读`)
  if (c.mention) parts.push('有人提到你')
  if (c.muted) parts.push('已免打扰')
  return parts.join('，')
}

function sidebarItem(c) {
  const current = state.conv === c.id && state.view === 'app'
  const unread = c.unread > 0
  return h(
    'button.s-item.focus-inset',
    {
      type: 'button',
      'aria-current': current ? 'true' : null,
      'aria-label': itemLabel(c),
      dataset: { id: c.id, unread: unread ? 'true' : 'false' },
      tabindex: current ? '0' : '-1',
      onclick: () => selectConversation(c.id),
    },
    convAvatar(c, 36),
    h(
      'span.s-item__body',
      h('span.s-item__title', h('span.truncate', convTitle(c))),
      h('span.s-item__preview', c.last || '还没有消息'),
    ),
    h(
      'span.s-item__meta',
      h('span.s-item__time', c.muted ? icon('bell-off', 16) : null, c.time),
      h(
        'span.s-item__badges',
        c.mention ? badge('@') : null,
        unread ? badge(c.unread > 99 ? '99+' : String(c.unread), c.muted ? 'muted' : '') : null,
      ),
    ),
  )
}

function openCreateMenu(anchor, event) {
  openMenu({
    anchor,
    placement: 'bottom-end',
    focusFirst: event?.detail === 0,
    ariaLabel: '新建',
    items: [
      {
        label: '新建频道',
        icon: 'hash',
        onSelect: () => toast('原型：这里会打开「新建频道」面板'),
      },
      {
        label: '新建群组',
        icon: 'users',
        onSelect: () => toast('原型：这里会打开「新建群组」面板'),
      },
      {
        label: '发起私信',
        icon: 'message-circle',
        onSelect: () => bus.emit('palette:open', { query: '' }),
      },
      { type: 'separator' },
      { label: '新的助手会话', icon: 'sparkles', onSelect: () => selectConversation('ag-new') },
    ],
  })
}

function openArchived() {
  const rename = h('input.input', {
    id: 'restore-name',
    value: '设计（旧）',
    'aria-describedby': 'restore-err',
  })
  const list = h(
    'div',
    { style: { display: 'grid', gap: '12px' } },
    h(
      'div.row',
      h(
        'div.row__main',
        h('div.row__title', '# 旧项目'),
        h('div.row__help', '你是群主 · 归档于 9月12日'),
      ),
      h(
        'div.row__control',
        button({ label: '恢复', kind: 'tinted', onClick: () => toast('已恢复「旧项目」') }),
      ),
    ),
    h(
      'div',
      { style: { display: 'grid', gap: '8px' } },
      h(
        'div.row',
        h(
          'div.row__main',
          h('div.row__title', '# 设计'),
          h('div.row__help', '你是群主 · 归档于 8月30日'),
        ),
      ),
      h(
        'div.field',
        h('label.field__label', { for: 'restore-name' }, '改名后再恢复'),
        rename,
        h(
          'div.field__error#restore-err',
          icon('circle-alert', 16),
          '名称「设计」已被新频道占用，请先改名。',
        ),
      ),
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'flex-end' } },
        button({
          label: '改名并恢复',
          kind: 'filled',
          onClick: () => toast(`已恢复，名称改为「${rename.value}」`),
        }),
      ),
    ),
  )
  openDialog({
    title: '已归档的会话',
    body: [
      h(
        'p',
        { style: { marginBottom: '12px' } },
        '归档后会话只读，并从成员的列表中移除。群主和站点管理员可以在这里恢复。',
      ),
      list,
    ],
    actions: [{ label: '完成', kind: 'plain' }],
    wide: true,
  })
}

export function renderSidebar() {
  const el = ui.sidebarEl
  const hadFocus = el.contains(document.activeElement)
    ? document.activeElement.getAttribute('data-id')
    : null
  el.dataset.compact = String(state.prefs.compact)
  const scroll = h('div.sidebar__scroll.scroll')
  const keep = ui.sidebarScroll ?? 0

  for (const section of SECTIONS) {
    const items = conversations
      .filter((c) => !c.hidden && (!c.fresh || section.id === 'agents'))
      .filter(section.pick)
    if (items.length === 0 && section.id !== 'agents') continue
    const open = !collapsed.has(section.id)
    const headingId = `sec-${section.id}`
    const head = h(
      'div.s-section__head',
      h(
        'button.s-section__toggle.focus-inset',
        {
          type: 'button',
          'aria-expanded': String(open),
          'aria-controls': `list-${section.id}`,
          onclick: () => {
            if (open) collapsed.add(section.id)
            else collapsed.delete(section.id)
            renderSidebar()
          },
        },
        icon('chevron-down', 16),
        h('span', { id: headingId }, section.label),
      ),
      section.add
        ? iconButton({
            icon: 'plus',
            label: section.add,
            size: 16,
            cls: 'icon-btn--sm',
            onClick: (event) => openCreateMenu(event.currentTarget, event),
          })
        : null,
    )
    const list = h(
      'ul',
      { id: `list-${section.id}`, 'aria-labelledby': headingId, hidden: !open },
      items.map((c) => h('li', sidebarItem(c))),
    )
    const sec = h('section.s-section', head, list)
    if (section.more && open) {
      list.appendChild(
        h(
          'li',
          button({
            label: '更多',
            icon: 'ellipsis',
            kind: 'plain',
            size: 'sm',
            style: { color: 'var(--label-secondary)', marginLeft: '4px' },
            'aria-haspopup': 'menu',
            onClick: (event) =>
              openMenu({
                anchor: event.currentTarget,
                focusFirst: event.detail === 0,
                ariaLabel: '更多',
                items: [
                  { label: '已归档…', icon: 'archive', onSelect: openArchived },
                  {
                    label: '发现更多频道',
                    icon: 'search',
                    onSelect: () => bus.emit('palette:open', { query: '' }),
                  },
                ],
              }),
          }),
        ),
      )
    }
    scroll.appendChild(sec)
  }

  const unreadCount = notifications.filter((n) => n.unread).length
  const me = people.me
  const searchButton = h(
    'button.search.search--plate.focus-inset',
    {
      type: 'button',
      'aria-label': '搜索',
      'data-tip': '搜索与命令',
      'data-tip-keys': shortcut('⌘', 'K'),
      onclick: () => bus.emit('palette:open', { query: '' }),
    },
    icon('search', 16),
    h('span.search__text', '搜索'),
    h('kbd', shortcut('⌘', 'K')),
  )
  const bell = h(
    'button.icon-btn.bell',
    {
      type: 'button',
      'aria-label': unreadCount ? `通知，${unreadCount} 条未读` : '通知',
      'aria-haspopup': 'dialog',
      'data-tip': '通知',
      onclick: (event) => bus.emit('notifications:toggle', event.currentTarget),
    },
    icon('bell', 18),
    unreadCount ? h('span.bell__count', { 'aria-hidden': 'true' }, String(unreadCount)) : null,
  )
  const settings = iconButton({
    icon: 'settings',
    label: '设置',
    keys: shortcut('⌘', ','),
    onClick: () => bus.emit('settings:open', 'appearance'),
  })

  el.replaceChildren(
    h(
      'div.sidebar__top',
      searchButton,
      iconButton({
        icon: 'square-pen',
        label: '新建',
        tip: '新建会话',
        onClick: (event) => openCreateMenu(event.currentTarget, event),
      }),
    ),
    scroll,
    h(
      'div.sidebar__user',
      h(
        'button.sidebar__user-main.focus-inset',
        {
          type: 'button',
          'aria-label': `${me.name}，${presenceLabel(me.status)}，账号设置`,
          onclick: () => bus.emit('settings:open', 'account'),
        },
        avatar('me', { size: 34, presence: true }),
        h(
          'div',
          h('div.sidebar__user-name', me.name),
          h('div.sidebar__user-status', presenceLabel(me.status)),
        ),
      ),
      bell,
      settings,
    ),
  )
  scroll.scrollTop = keep
  scroll.addEventListener('scroll', () => {
    ui.sidebarScroll = scroll.scrollTop
  })
  if (hadFocus) el.querySelector(`[data-id="${hadFocus}"]`)?.focus({ preventScroll: true })
  if (!$$('.s-item[tabindex="0"]', el).length)
    el.querySelector('.s-item')?.setAttribute('tabindex', '0')
}

/** Roving tabindex: one tab stop for the whole list, arrow keys move between conversations. */
function onListKey(event) {
  const item = event.target.closest?.('.s-item')
  if (!item) return
  const items = $$('.s-item', ui.sidebarEl).filter((el) => !el.closest('[hidden]'))
  const index = items.indexOf(item)
  const move = { ArrowDown: 1, ArrowUp: -1 }[event.key]
  let next
  if (move && !event.altKey) next = items[clamp(index + move, 0, items.length - 1)]
  else if (event.key === 'Home') next = items[0]
  else if (event.key === 'End') next = items[items.length - 1]
  if (!next) return
  event.preventDefault()
  for (const el of items) el.tabIndex = el === next ? 0 : -1
  next.focus()
}

function initSplitter() {
  const splitter = ui.splitterEl
  const min = 240
  const max = 360
  const set = (value) => {
    const next = clamp(Math.round(value), min, max)
    state.prefs.sidebarW = next
    ui.windowEl.style.setProperty('--sidebar-w', `${next}px`)
    splitter.setAttribute('aria-valuenow', String(next))
  }
  splitter.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    splitter.setPointerCapture(event.pointerId)
    splitter.dataset.dragging = 'true'
    const startX = event.clientX
    const startW = state.prefs.sidebarW
    const move = (e) => set(startW + (e.clientX - startX))
    const up = () => {
      splitter.dataset.dragging = 'false'
      splitter.removeEventListener('pointermove', move)
      splitter.removeEventListener('pointerup', up)
      bus.emit('prefs', { key: 'sidebarW', value: state.prefs.sidebarW })
    }
    splitter.addEventListener('pointermove', move)
    splitter.addEventListener('pointerup', up)
  })
  splitter.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 32 : 12
    if (event.key === 'ArrowLeft') set(state.prefs.sidebarW - step)
    else if (event.key === 'ArrowRight') set(state.prefs.sidebarW + step)
    else if (event.key === 'Home') set(min)
    else if (event.key === 'End') set(max)
    else return
    event.preventDefault()
  })
  splitter.addEventListener('dblclick', () => set(280))
}

export function initSidebar() {
  ui.sidebarEl.addEventListener('keydown', onListKey)
  initSplitter()
  bus.on('conv', renderSidebar)
  bus.on('prefs', (e) => (e.key === 'compact' || e.key === '*') && renderSidebar())
  bus.on('sidebar:refresh', renderSidebar)
}

export { conv }
