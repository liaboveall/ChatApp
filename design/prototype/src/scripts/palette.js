// Command palette (docs/02 section 6): jump to conversations, search messages by keyword (no AI quota),
// run commands, or ask the assistant. Everything in the app is reachable from here (docs/02 section 7).

import { bus, selectConversation, setPref, shortcut, state, ui } from './core.js'
import { commands, conversations, convTitle, messages, people } from './data.js'
import { h, icon } from './dom.js'
import { openModal, toast } from './overlays.js'
import { convAvatar } from './widgets.js'

let handle = null

const text = (m) =>
  (m.text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<@user:([\w-]+)>/g, (_, id) => `@${people[id]?.name ?? id}`)
    .replace(/[*`~]/g, '')

function searchMessages(query) {
  const q = query.toLowerCase()
  const out = []
  for (const c of conversations) {
    if (c.fresh || c.hidden) continue
    for (const m of messages[c.id] ?? []) {
      if (m.k && m.k !== 'agent') continue
      const body = text(m)
      const i = body.toLowerCase().indexOf(q)
      if (i < 0) continue
      out.push({ conv: c, m, body, i })
    }
  }
  return out.slice(0, 5)
}

function highlight(body, i, len) {
  const start = Math.max(0, i - 12)
  return [
    start > 0 ? '…' : '',
    body.slice(start, i),
    h('span.hl', body.slice(i, i + len)),
    body.slice(i + len, i + len + 40),
  ]
}

const ACTIONS = [
  {
    label: '打开设置',
    icon: 'settings',
    hint: shortcut('⌘', ','),
    run: () => bus.emit('settings:open', 'appearance'),
  },
  { label: '外观：深色', icon: 'moon', run: () => setPref('theme', 'dark') },
  { label: '外观：浅色', icon: 'sun', run: () => setPref('theme', 'light') },
  { label: '外观：跟随系统', icon: 'monitor', run: () => setPref('theme', 'system') },
  { label: '新建频道', icon: 'hash', run: () => toast('原型：这里会打开「新建频道」面板') },
  {
    label: '快捷键帮助',
    icon: 'keyboard',
    hint: shortcut('⌘', '/'),
    run: () => bus.emit('shortcuts:open'),
  },
  {
    label: '通知中心',
    icon: 'bell',
    run: () => bus.emit('notifications:toggle', ui.sidebarEl.querySelector('.bell')),
  },
]

export function closePalette() {
  handle?.close()
}

export function openPalette({ query = '' } = {}) {
  if (handle) {
    handle.close()
    return
  }
  let active = 0
  let rows = []
  const listId = 'palette-list'
  const input = h('input#palette-input', {
    type: 'text',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    'aria-label': '搜索会话、消息，或输入命令',
    placeholder: '搜索会话、消息，或输入命令…',
    autocomplete: 'off',
    spellcheck: 'false',
    value: query,
  })
  const list = h('div.palette__list.scroll', { id: listId, role: 'listbox', 'aria-label': '结果' })
  const footNote = h('span')

  function build() {
    const q = input.value.trim()
    const isCommand = q.startsWith('/')
    const groups = []
    const ql = q.toLowerCase()
    if (!q) {
      groups.push({
        title: '最近会话',
        items: conversations
          .filter((c) => !c.fresh && !c.hidden)
          .slice(0, 4)
          .map((c) => ({
            key: c.id,
            icon: convAvatar(c, 28),
            label: convTitle(c),
            sub: c.last,
            run: () => selectConversation(c.id),
          })),
      })
      groups.push({
        title: '命令',
        items: commands.map((c) => ({
          key: c.id,
          icon: icon(c.icon, 18),
          label: c.label,
          sub: c.hint,
          tag: 'AI',
          run: () => runCommand(c.label),
        })),
      })
      groups.push({
        title: '操作',
        items: ACTIONS.slice(0, 4).map((a) => ({
          key: a.label,
          icon: icon(a.icon, 18),
          label: a.label,
          hint: a.hint,
          run: a.run,
        })),
      })
    } else if (isCommand) {
      const items = commands
        .filter((c) => c.label.startsWith(q.split(' ')[0]) || q === '/')
        .map((c) => ({
          key: c.id,
          icon: icon(c.icon, 18),
          label: c.label,
          sub: c.hint,
          tag: 'AI',
          run: () => runCommand(q),
        }))
      groups.push({ title: '命令', items })
    } else {
      const convs = conversations
        .filter((c) => !c.fresh && !c.hidden && convTitle(c).toLowerCase().includes(ql))
        .map((c) => ({
          key: c.id,
          icon: convAvatar(c, 28),
          label: convTitle(c),
          sub:
            c.kind === 'dm'
              ? '私信'
              : c.kind === 'channel'
                ? '频道'
                : c.kind === 'group'
                  ? '群组'
                  : '助手会话',
          run: () => selectConversation(c.id),
        }))
      if (convs.length) groups.push({ title: '会话', items: convs })
      const found = q.length >= 2 ? searchMessages(q) : []
      if (found.length) {
        groups.push({
          title: '消息 · 关键词搜索，不消耗额度',
          items: found.map(({ conv, m, body, i }) => ({
            key: `${conv.id}-${m.id}`,
            icon: icon('message-circle', 18),
            label: highlight(body, i, q.length),
            sub: `${convTitle(conv)} · ${people[m.from]?.name ?? ''}`,
            run: () => (
              selectConversation(conv.id), setTimeout(() => bus.emit('timeline:jump', m.id), 60)
            ),
          })),
        })
      }
      const acts = ACTIONS.filter((a) => a.label.toLowerCase().includes(ql))
      if (acts.length)
        groups.push({
          title: '操作',
          items: acts.map((a) => ({
            key: a.label,
            icon: icon(a.icon, 18),
            label: a.label,
            hint: a.hint,
            run: a.run,
          })),
        })
    }
    if (q && !isCommand) {
      groups.push({
        title: '助手',
        items: [
          {
            key: 'ask',
            icon: icon('spark', 18, 'icon--fill'),
            label: `问助手：${q}`,
            sub: '只看当前会话 · 会使用额度',
            tag: 'AI',
            run: () => ask(q),
          },
        ],
      })
    }
    rows = []
    const nodes = []
    for (const g of groups) {
      if (!g.items.length) continue
      nodes.push(h('div.palette__group', { role: 'presentation' }, g.title))
      for (const item of g.items) {
        const index = rows.length
        rows.push(item)
        nodes.push(
          h(
            'div.palette__row',
            {
              role: 'option',
              id: `pal-${index}`,
              'aria-selected': String(index === active),
              dataset: { active: String(index === active) },
              onpointermove: () => setActive(index, false),
              onclick: () => choose(index),
            },
            h('span.palette__icon', item.icon),
            h(
              'span.palette__main',
              h('span.palette__label.truncate', item.label),
              item.sub ? h('span.palette__sub.truncate', item.sub) : null,
            ),
            item.tag ? h('span.badge.badge--role', item.tag) : null,
            item.hint ? h('span.palette__hint', item.hint) : null,
          ),
        )
      }
    }
    if (rows.length === 0)
      nodes.push(
        h(
          'div.empty',
          { style: { padding: '28px 20px' } },
          h('div.empty__title', '没有找到结果'),
          h('p.empty__text', '换个关键词试试，或者直接问助手。'),
        ),
      )
    list.replaceChildren(...nodes)
    active = Math.min(active, Math.max(0, rows.length - 1))
    input.setAttribute('aria-activedescendant', rows.length ? `pal-${active}` : '')
    footNote.textContent = q && !isCommand ? '助手只读取当前会话，除非你在助手面板里切换范围' : ''
  }

  function setActive(index, scroll = true) {
    if (index === active || rows.length === 0) return
    active = (index + rows.length) % rows.length
    for (const [i, el] of [...list.querySelectorAll('.palette__row')].entries()) {
      el.dataset.active = String(i === active)
      el.setAttribute('aria-selected', String(i === active))
      if (i === active && scroll) el.scrollIntoView({ block: 'nearest' })
    }
    input.setAttribute('aria-activedescendant', `pal-${active}`)
  }

  function choose(index) {
    const row = rows[index]
    if (!row) return
    handle?.close()
    row.run()
  }

  function runCommand(raw) {
    const word = raw.split(' ')[0]
    if (word === '/总结') {
      bus.emit('inspector:set', 'assistant')
      setTimeout(
        () => bus.emit('assistant:ask', { kind: 'unread', prompt: '总结这个会话的未读消息' }),
        80,
      )
    } else if (word === '/翻译') {
      bus.emit('inspector:set', 'assistant')
      setTimeout(
        () => bus.emit('assistant:ask', { kind: 'translate', prompt: '翻译选中的内容' }),
        80,
      )
    } else {
      selectConversation('ag-weekly')
      const prompt = raw.replace(/^\/提醒我\s*/, '') || '明天上午 9 点提交周报'
      setTimeout(
        () =>
          bus.emit('agent:run', { convId: 'ag-weekly', prompt: `提醒我 ${prompt}`, mode: 'fast' }),
        80,
      )
    }
  }

  function ask(q) {
    bus.emit('inspector:set', 'assistant')
    setTimeout(() => bus.emit('assistant:ask', { kind: 'range', prompt: q }), 80)
  }

  input.addEventListener('input', () => {
    active = 0
    build()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(active + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(active - 1)
    } else if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      choose(active)
    }
  })

  const panel = h(
    'div.palette.glass-text',
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': '命令面板' },
    h('div.palette__head', icon('search', 20), input, h('kbd', 'Esc')),
    list,
    h(
      'div.palette__foot',
      h('span', h('kbd', '↑'), h('kbd', '↓'), ' 选择 ', h('kbd', 'Enter'), ' 打开'),
      footNote,
    ),
  )
  const scrim = h('div.scrim')
  const layer = h(
    'div',
    { style: { position: 'absolute', inset: '0', zIndex: '1100', pointerEvents: 'auto' } },
    scrim,
    h('div.palette-host', panel),
  )
  build()
  handle = openModal({
    layer,
    scrim: layer,
    initialFocus: input,
    onClose: () => {
      handle = null
    },
  })
  input.setSelectionRange(input.value.length, input.value.length)
  return handle
}

export function initPalette() {
  bus.on('palette:open', (opts) => openPalette(opts))
  bus.on('palette:close', closePalette)
}

export { state }
