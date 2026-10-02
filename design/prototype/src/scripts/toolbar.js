// Toolbar (docs/02 section 3): conversation name, subtitle, members, assistant panel, more.

import { bus, selectConversation, shortcut, state, ui } from './core.js'
import { conv, convTitle, people } from './data.js'
import { h, icon } from './dom.js'
import { openDialog, openMenu, toast } from './overlays.js'
import { botBadge, button, convAvatar, iconButton, presenceLabel, seg } from './widgets.js'

export const session = { keySource: 'site', mode: 'fast' }

function subtitle(c) {
  if (c.kind === 'dm') {
    const p = people[c.person]
    return p.status === 'offline' ? `最后在线 ${p.seen}` : presenceLabel(p.status)
  }
  if (c.kind === 'agent') {
    return `只有你能看到 · ${session.mode === 'deep' ? '深度' : '快速'}模式 · ${session.keySource === 'user' ? '使用你的 API key' : '使用站点额度'}`
  }
  const count = c.memberCount ?? c.members.length
  return c.desc ? `${count} 位成员 · ${c.desc}` : `${count} 位成员`
}

function moreMenu(anchor, event) {
  const c = conv(state.conv)
  const items = []
  if (c.kind === 'agent') {
    items.push(
      { label: '重命名会话', icon: 'pencil', onSelect: () => toast('原型：这里会就地重命名') },
      { type: 'separator' },
      {
        label: '删除会话',
        icon: 'trash',
        danger: true,
        onSelect: () =>
          openDialog({
            title: `删除「${c.name}」？`,
            body: '消息会立即删除，附件立即不可读，运行记录按保留期清除。进行中的任务和待批准的操作会被取消。',
            actions: [
              { label: '取消', kind: 'plain', autofocus: true },
              {
                label: '删除',
                kind: 'filled',
                danger: true,
                onClick: () => (toast('已删除会话'), selectConversation('ag-weekly')),
              },
            ],
          }),
      },
    )
  } else {
    items.push(
      {
        label: c.pinned ? '取消置顶' : '置顶会话',
        icon: c.pinned ? 'pin-off' : 'pin',
        onSelect: () => (
          (c.pinned = !c.pinned),
          bus.emit('sidebar:refresh'),
          toast(c.pinned ? '已置顶' : '已取消置顶')
        ),
      },
      {
        label: c.muted ? '关闭免打扰' : '免打扰',
        icon: c.muted ? 'bell' : 'bell-off',
        hint: c.muted ? '' : '永久',
        onSelect: () => (
          (c.muted = !c.muted),
          bus.emit('sidebar:refresh'),
          bus.emit('toolbar:refresh'),
          toast(c.muted ? '已设为永久免打扰，直到你关闭' : '已关闭免打扰')
        ),
      },
      { type: 'label', label: '通知级别' },
      { label: '全部消息', checked: false, onSelect: () => toast('通知级别：全部消息') },
      { label: '仅 @我', checked: true, onSelect: () => toast('通知级别：仅 @我') },
      { label: '关闭', checked: false, onSelect: () => toast('通知级别：关闭') },
      { type: 'separator' },
      {
        label: '搜索消息',
        icon: 'search',
        hint: shortcut('⌘', 'K'),
        onSelect: () => bus.emit('palette:open', { query: '' }),
      },
      {
        label: '复制会话链接',
        icon: 'link',
        onSelect: () => toast('链接已复制，只有已注册的成员能用它加入'),
      },
      { type: 'separator' },
      {
        label: c.kind === 'channel' ? '归档频道（群主）' : '归档群组（群主）',
        icon: 'archive',
        onSelect: () => toast('原型：归档后会话只读，可在「已归档」里恢复'),
      },
      {
        label: '退出会话',
        icon: 'log-out',
        danger: true,
        onSelect: () => toast('原型：群主需要先转让才能退出'),
      },
    )
  }
  openMenu({
    anchor,
    placement: 'bottom-end',
    focusFirst: event?.detail === 0,
    ariaLabel: '更多操作',
    items,
  })
}

function keySourceMenu(anchor, event) {
  openMenu({
    anchor,
    placement: 'bottom-end',
    focusFirst: event?.detail === 0,
    ariaLabel: '助手使用的 key',
    items: [
      { type: 'label', label: '当前来源' },
      {
        label: '站点额度',
        checked: session.keySource === 'site',
        onSelect: () => switchSource('site'),
      },
      {
        label: '我的 API key',
        checked: session.keySource === 'user',
        onSelect: () => switchSource('user'),
      },
    ],
  })
}

function switchSource(next) {
  if (next === session.keySource) return
  session.keySource = next
  renderToolbar()
  bus.emit(
    'assistant:epoch',
    next === 'user'
      ? '已切换到你的 API key，新对话不会沿用之前的私有上下文'
      : '已切换到站点额度，新对话不会沿用你的私有上下文',
  )
  toast('已新开对话段：旧的私有内容不会自动带入')
}

export function renderToolbar() {
  const el = ui.toolbarEl
  const c = conv(state.conv)
  el.hidden = !c
  if (!c) return
  const detailsOpen = state.inspector === 'details'
  const assistOpen = state.inspector === 'assistant'
  const isAgent = c.kind === 'agent'

  const actions = []
  if (isAgent) {
    actions.push(
      seg({
        label: '回答模式',
        value: session.mode,
        items: [
          { value: 'fast', label: '快速' },
          { value: 'deep', label: '深度' },
        ],
        className: 'mode-seg',
        onChange: (value) => {
          session.mode = value
          renderToolbar()
        },
      }),
      iconButton({
        icon: 'key-round',
        label: '助手使用的 key',
        tip: `来源：${session.keySource === 'user' ? '我的 API key' : '站点额度'}`,
        'aria-haspopup': 'menu',
        onClick: (event) => keySourceMenu(event.currentTarget, event),
      }),
    )
  } else {
    actions.push(
      iconButton({
        icon: c.kind === 'dm' ? 'panel-right' : 'users',
        label: c.kind === 'dm' ? '详情' : '成员与详情',
        tip: c.kind === 'dm' ? '详情' : `成员（${c.memberCount ?? c.members.length}）`,
        pressed: detailsOpen,
        onClick: () => bus.emit('inspector:set', detailsOpen ? 'closed' : 'details'),
      }),
      iconButton({
        icon: 'spark',
        label: '助手面板',
        tip: '助手面板',
        keys: shortcut('⌘', 'J'),
        pressed: assistOpen,
        onClick: () => bus.emit('inspector:set', assistOpen ? 'closed' : 'assistant'),
        size: 18,
        cls: 'toolbar__spark',
      }),
    )
  }
  actions.push(
    iconButton({
      icon: 'ellipsis',
      label: '更多',
      'aria-haspopup': 'menu',
      onClick: (event) => moreMenu(event.currentTarget, event),
    }),
  )

  const who = h(
    'button.toolbar__who.focus-inset',
    {
      type: 'button',
      'aria-label': `${convTitle(c)}，会话详情`,
      onclick: () => !isAgent && bus.emit('inspector:set', detailsOpen ? 'closed' : 'details'),
    },
    convAvatar(c, 34),
    h(
      'span',
      { style: { minWidth: '0', display: 'grid' } },
      h(
        'span.toolbar__title',
        h('span.truncate', c.kind === 'channel' ? `# ${c.name}` : convTitle(c)),
        c.muted ? icon('bell-off', 16) : null,
        isAgent ? botBadge() : null,
      ),
      h('span.toolbar__sub', subtitle(c)),
    ),
  )

  el.replaceChildren(
    iconButton({
      icon: 'panel-left',
      label: '会话列表',
      tip: '会话列表',
      cls: 'toolbar__menu-btn',
      onClick: () => bus.emit('drawer:toggle'),
    }),
    who,
    h('div.toolbar__actions', actions),
  )
}

export function initToolbar() {
  bus.on('conv', renderToolbar)
  bus.on('inspector', renderToolbar)
  bus.on('toolbar:refresh', renderToolbar)
  bus.on('prefs', () => renderToolbar())
}

export { button }
