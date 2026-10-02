// Timeline (docs/02 section 5): grouped bubbles, separators, quotes, attachments, hover tools,
// context menu, typing, jump to latest. The list is solid; toolbar and composer float above it.

import { renderAgentMessage } from './agent.js'
import { appIcon } from './brand.js'
import { bus, keycap, selectConversation, state, ui } from './core.js'
import { conv, ME, messages, people, scenes, shortcuts } from './data.js'
import { $, $$, announce, clamp, copyText, h, icon } from './dom.js'
import { parseInline, renderMarkdown } from './markdown.js'
import { openDialog, openMenu, toast } from './overlays.js'
import { avatar, botBadge, button, iconButton, spinner } from './widgets.js'

const minutes = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

function mentionNode(id) {
  const p = people[id]
  return h('span.mention', `@${p ? p.name : id}`)
}

export const mdContext = { mention: mentionNode }

/** First 100 characters of a message, without markup, for quotes (docs/01 4.5). */
function snippet(m) {
  if (m.k === 'images') return '[图片]'
  if (m.k === 'file') return `[文件] ${m.att?.[0]?.name ?? ''}`
  const text = (m.text ?? '')
    .replace(/```[\s\S]*?```/g, '[代码]')
    .replace(/<@user:([\w-]+)>/g, (_, id) => `@${people[id]?.name ?? id}`)
    .replace(/[*`~]/g, '')
  return text.length > 100 ? `${text.slice(0, 100)}…` : text
}

function dateSep(m) {
  return h('div.date-sep', h('span', m.label))
}

function unreadDivider() {
  return h('div.unread-div', { role: 'separator', 'aria-label': '以下为新消息' }, '以下为新消息')
}

function systemNotice(m) {
  return h(
    'div.sys',
    { role: 'note' },
    parseInline(m.text, mdContext),
    m.action
      ? button({
          label: m.action,
          kind: 'tinted',
          size: 'sm',
          onClick: () => bus.emit('inspector:set', 'assistant'),
        })
      : null,
  )
}

function boundary(m) {
  return h(
    'div.history-boundary',
    { role: 'note' },
    icon('eye-off', 18),
    h(
      'div',
      `你于 ${m.when} 加入，之前的消息不可见`,
      h('small', '新成员只能看到加入之后的消息，搜索和助手也一样。'),
    ),
  )
}

function pendingDeleteDialog() {
  const steps = [
    ['circle-check', '已保存删除记录', false],
    ['circle-check', '已清空在线正文和附件访问', false],
    ['loader', '等待异地确认', true],
  ]
  openDialog({
    title: '删除待完成',
    body: [
      h('p', '在异地确认之前，这条消息的内容仍可能可见。完成后这里会自动更新。'),
      h(
        'ul',
        { style: { display: 'grid', gap: '8px', marginTop: '12px', color: 'var(--label)' } },
        steps.map(([ic, text, busy]) =>
          h(
            'li',
            { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            busy ? spinner() : icon(ic, 16, ''),
            text,
          ),
        ),
      ),
    ],
    actions: [{ label: '知道了', kind: 'filled', autofocus: true }],
  })
}

function notice(m) {
  if (m.k === 'recalled') {
    const who = m.from === ME ? '你' : people[m.from].name
    return h('div.sys', { role: 'note' }, `${who}撤回了一条消息`)
  }
  if (m.k === 'adminDeleted') return h('div.sys', { role: 'note' }, '此消息已被管理员删除')
  return h(
    'div.pending-delete',
    { role: 'status' },
    icon('hourglass', 18),
    h('div', { style: { flex: '1' } }, '删除待完成，内容仍可能可见'),
    button({ label: '查看进度', kind: 'plain', size: 'sm', onClick: pendingDeleteDialog }),
  )
}

function attachment(m) {
  const items = m.att ?? []
  if (m.k === 'file') {
    const f = items[0]
    return h(
      'a.att-file',
      {
        href: '#',
        onclick: (e) => (e.preventDefault(), toast(`原型：下载「${f.name}」`)),
        'aria-label': `${f.name}，${f.size}，下载`,
      },
      h('span.att-file__icon', icon('file-text', 20)),
      h(
        'span',
        { style: { flex: '1', minWidth: '0' } },
        h('div.att-file__name.truncate', f.name),
        h('div.att-file__size', f.size),
      ),
      icon('download', 18),
    )
  }
  const cells = items.slice(0, 4).map((a) =>
    h(
      'button.att-img.focus-inset',
      {
        type: 'button',
        style: { 'background-image': scenes[a.scene] },
        'aria-label': `查看大图：${a.alt}`,
        onclick: () => lightbox(a),
      },
      h('span.att-img__img'),
      m.k === 'video' ? h('span.att-play', h('span', icon('play', 20))) : null,
    ),
  )
  return h('div.att-grid', { dataset: { count: String(cells.length) } }, cells)
}

function lightbox(a) {
  openDialog({
    title: a.alt,
    wide: true,
    body: h('div', {
      style: {
        aspectRatio: '4 / 3',
        borderRadius: '12px',
        backgroundImage: scenes[a.scene],
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      },
      role: 'img',
      'aria-label': a.alt,
    }),
    actions: [{ label: '关闭', kind: 'filled', autofocus: true }],
  })
}

function quoteOf(m, list) {
  const target = list.find((x) => x.id === m.reply)
  const hidden = !target || m.reply === 'hidden'
  if (hidden) {
    return h(
      'div.bubble__quote',
      { 'data-hidden': 'true' },
      h('b', '回复'),
      h('span', '原消息不可见'),
    )
  }
  if (target.k === 'recalled')
    return h(
      'div.bubble__quote',
      { 'data-hidden': 'true' },
      h('b', '回复'),
      h('span', '原消息已撤回'),
    )
  return h(
    'button.bubble__quote',
    {
      type: 'button',
      'aria-label': `跳到被回复的消息：${snippet(target)}`,
      onclick: () => jumpTo(target.id),
    },
    h('b', target.from === ME ? '你' : people[target.from].name),
    h('span', snippet(target)),
  )
}

export function jumpTo(id) {
  const el = ui.timelineEl.querySelector(`[data-msg="${id}"]`)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.remove('msg--flash')
  void el.offsetWidth
  el.classList.add('msg--flash')
  setTimeout(() => el.classList.remove('msg--flash'), 1000)
  el.focus({ preventScroll: true })
}

function fullTime(day, t) {
  return day ? `${day} ${t}` : t
}

function messageMenuItems(m, isMine, lastOwnId) {
  const text = m.text ?? ''
  return [
    { label: '回复', icon: 'reply', onSelect: () => bus.emit('composer:reply', m) },
    {
      label: '复制',
      icon: 'copy',
      onSelect: () =>
        copyText(text.replace(/<@user:([\w-]+)>/g, (_, id) => `@${people[id]?.name ?? id}`)).then(
          () => toast('已复制'),
        ),
    },
    {
      label: '交给助手',
      icon: 'sparkles',
      hint: '带入助手面板',
      onSelect: () => bus.emit('assistant:handoff', m),
    },
    { type: 'separator' },
    ...(isMine
      ? [
          {
            label: '编辑',
            icon: 'pencil',
            hint: '24 小时内',
            onSelect: () => bus.emit('composer:edit', m),
          },
          {
            label: '撤回',
            icon: 'undo-2',
            hint: m.id === lastOwnId ? '2 分钟内' : '已超时',
            disabled: m.id !== lastOwnId,
            onSelect: () => recall(m),
          },
        ]
      : [{ label: '举报', icon: 'flag', onSelect: () => report(m) }]),
    { label: '删除（仅自己）', icon: 'trash', danger: true, onSelect: () => removeForMe(m) },
  ]
}

function recall(m) {
  const list = messages[state.conv]
  const i = list.findIndex((x) => x.id === m.id)
  if (i < 0) return
  list[i] = { id: m.id, k: 'recalled', from: m.from, t: m.t }
  renderTimeline({ keepScroll: true })
  toast('已撤回。所有人都会看到你撤回了一条消息')
}

function removeForMe(m) {
  const list = messages[state.conv]
  const i = list.findIndex((x) => x.id === m.id)
  if (i < 0) return
  list.splice(i, 1)
  renderTimeline({ keepScroll: true })
  toast('已从你的视图中移除，其他人不受影响')
}

function report(m) {
  openDialog({
    title: '举报这条消息',
    body: [
      h('p', { style: { marginBottom: '10px' } }, `${people[m.from].name}：${snippet(m)}`),
      h(
        'div',
        { role: 'radiogroup', 'aria-label': '举报原因', style: { display: 'grid', gap: '4px' } },
        ['骚扰或辱骂', '垃圾信息', '违法或危险内容', '其他'].map((r, i) =>
          h('label.check', h('input', { type: 'radio', name: 'reason', checked: i === 0 }), r),
        ),
      ),
      h(
        'p.t-sub.t-secondary',
        { style: { marginTop: '10px' } },
        '站点管理员会看到这条消息以及前后各 5 条。',
      ),
    ],
    actions: [
      { label: '取消', kind: 'plain' },
      { label: '提交举报', kind: 'filled', onClick: () => toast('已提交举报') },
    ],
  })
}

function renderMessage(m, ctx) {
  const { out, first, last, list, day, lastOwnId } = ctx
  const isAgent = m.k === 'agent'
  const who = m.from
  const name = who === ME ? '你' : people[who].name
  let content
  if (isAgent) content = renderAgentMessage(m, { last })
  else if (m.k === 'images' || m.k === 'file' || m.k === 'video') content = [attachment(m)]
  else {
    const hasQuote = Boolean(m.reply)
    content = [
      h(
        `div.bubble.bubble--${out ? 'out' : 'in'}${first ? '' : '.bubble--join-prev'}${last ? '' : '.bubble--join-next'}${last ? '.bubble--tail' : ''}${m.state === 'sending' ? '.bubble--sending' : ''}`,
        hasQuote ? quoteOf(m, list) : null,
        renderMarkdown(m.text ?? '', mdContext),
      ),
    ]
  }

  const tools = h(
    'div.msg__tools.glass-lite',
    { role: 'toolbar', 'aria-label': '消息操作' },
    iconButton({ icon: 'reply', label: '回复', onClick: () => bus.emit('composer:reply', m) }),
    isAgent && m.canRegenerate
      ? iconButton({
          icon: 'refresh-cw',
          label: '重新生成',
          tip: '重新生成（替换原回复）',
          onClick: () => bus.emit('agent:regenerate', m),
        })
      : null,
    iconButton({
      icon: 'ellipsis',
      label: '更多',
      'aria-haspopup': 'menu',
      onClick: (event) =>
        openMenu({
          anchor: event.currentTarget,
          placement: 'bottom-start',
          focusFirst: event.detail === 0,
          ariaLabel: '消息操作',
          items: messageMenuItems(m, out, lastOwnId),
        }),
    }),
  )

  const status = m.via
    ? h('div.msg__status', icon('sparkles', 16), '经助手代发')
    : m.state === 'failed'
      ? h(
          'div.msg__status.msg__status--fail',
          icon('circle-alert', 16),
          '发送失败 · ',
          h(
            'button.btn.btn--plain.btn--sm',
            {
              type: 'button',
              style: { padding: '0 4px', minHeight: '24px' },
              onclick: () => retry(m),
            },
            '重试',
          ),
          '或',
          h(
            'button.btn.btn--plain.btn--sm.btn--danger',
            {
              type: 'button',
              style: { padding: '0 4px', minHeight: '24px' },
              onclick: () => removeForMe(m),
            },
            '删除',
          ),
        )
      : m.state === 'sending'
        ? h('div.msg__status', spinner(), '发送中')
        : m.edited
          ? h('div.msg__status', '已编辑')
          : null

  const el = h(
    `div.msg${m.mention ? '.msg--mention' : ''}${m.isNew ? '.msg--new' : ''}`,
    {
      role: 'article',
      tabindex: '-1',
      'aria-label': `${name}，${fullTime(day, m.t)}，${isAgent ? '助手回复' : snippet(m)}${m.mention ? '，提到了你' : ''}`,
      dataset: { who: out ? 'out' : 'in', msg: m.id, wide: isAgent || m.wide ? 'true' : 'false' },
      oncontextmenu: (event) => {
        event.preventDefault()
        openMenu({
          point: { x: event.clientX, y: event.clientY },
          ariaLabel: '消息操作',
          items: messageMenuItems(m, out, lastOwnId),
          focusFirst: false,
        })
      },
    },
    out && m.state === 'failed'
      ? h(
          'button.msg__fail',
          { type: 'button', 'aria-label': '发送失败，重试', onclick: () => retry(m) },
          icon('circle-alert', 20),
        )
      : null,
    !out ? h('div.msg__avatar', last ? avatar(who, { size: 28 }) : null) : null,
    h(
      'div.msg__col',
      content,
      status,
      h('span.msg__time', { 'aria-hidden': 'true' }, fullTime(day, m.t)),
    ),
    tools,
  )
  return el
}

function retry(m) {
  m.state = 'sending'
  renderTimeline({ keepScroll: true })
  setTimeout(() => {
    m.state = undefined
    renderTimeline({ keepScroll: true })
    toast('已重新发送，没有产生重复消息')
  }, 900)
}

function typingRow() {
  const who = state.typing
  if (!who?.length) return null
  const first = people[who[0]].name
  const label = who.length > 1 ? `${first}等 ${who.length} 人正在输入…` : `${first} 正在输入…`
  return h(
    'div.typing',
    { role: 'status', 'aria-label': label },
    h('div.msg__avatar', avatar(who[0], { size: 28 })),
    h('span.typing__dots', h('i'), h('i'), h('i')),
    h('span.typing__label', label),
  )
}

const SUGGESTIONS = [
  ['list-checks', '总结今天 #项目组 的讨论'],
  ['send-horizontal', '在 #项目组 说一声：周五评审改到 15:00'],
  ['alarm-clock', '明天上午 9 点提醒我交周报'],
  ['brain', '记住：我每周五要提交周报'],
  ['search', '帮我找一下关于迁移脚本的消息'],
]

/** An empty assistant session: what it can do, and prompts to try. */
function suggestions() {
  return h(
    'div.welcome',
    { style: { minHeight: '0', paddingBlock: '56px 8px' } },
    h(
      'div.empty__icon',
      { style: { width: '64px', height: '64px', borderRadius: '20px' } },
      icon('sparkles', 28),
    ),
    h('h1.t-title-1', '和助手聊聊'),
    h('p.t-body.t-secondary.t-balance', '它只读取你有权看到的内容；会影响别人的操作，都会先问你。'),
    h(
      'div.suggest',
      { style: { width: 'min(520px, 100%)' } },
      SUGGESTIONS.map(([name, text]) =>
        h(
          'button.suggest__item',
          { type: 'button', onclick: () => bus.emit('composer:send-text', text) },
          icon(name, 18),
          text,
        ),
      ),
    ),
  )
}

function welcome() {
  return h(
    'div.welcome',
    appIcon('a', 72),
    h('h1.t-title-1', '欢迎回来，周屿'),
    h('p.t-body.t-secondary.t-balance', '从左边选一个会话，或者用命令面板搜索、跳转、问助手。'),
    h(
      'div.welcome__keys',
      shortcuts.slice(0, 6).map((k) =>
        h(
          'div.keys-row',
          h('span', k.label),
          h(
            'span',
            k.keys.map((key) => h('kbd', keycap(key))),
          ),
        ),
      ),
    ),
  )
}

export function renderTimeline({ keepScroll = false, toBottom = true } = {}) {
  const el = ui.timelineEl
  const inner = $('.timeline__inner', el)
  const c = conv(state.conv)
  ui.mainEl.dataset.empty = c ? 'false' : 'true'
  if (!c) {
    inner.replaceChildren(welcome())
    return
  }
  const list = messages[state.conv] ?? []
  if (c.kind === 'agent' && list.length === 0) {
    inner.replaceChildren(suggestions())
    updateJump()
    return
  }
  const previousTop = el.scrollTop
  // A re-render replaces every message node. Keyboard focus must not be lost with them (docs/02 section 7).
  const focusedMsg = el.contains(document.activeElement)
    ? document.activeElement.closest?.('.msg')?.dataset.msg
    : null
  const nodes = []
  let group = null
  let day = ''
  const lastOwnId = [...list].reverse().find((m) => m.from === ME && !m.k)?.id

  const flush = () => {
    if (!group) return
    const items = group.items
    const out = group.from === ME
    const showName = !out && c.kind !== 'dm'
    const g = h(
      'div.msg-group',
      showName
        ? h(
            'div.msg-sender',
            people[group.from].name,
            people[group.from].bot ? botBadge() : null,
            items[0].scope && items[0].state !== 'streaming'
              ? h('span.msg-sender__scope', `· ${items[0].scope}`)
              : null,
          )
        : null,
      items.map((m, i) =>
        renderMessage(m, {
          out,
          first: i === 0,
          last: i === items.length - 1,
          list,
          day: group.day,
          lastOwnId,
        }),
      ),
    )
    nodes.push(g)
    group = null
  }

  for (const m of list) {
    const kind = m.k ?? 'text'
    if (kind === 'date') {
      flush()
      day = m.label.split(' ')[0]
      nodes.push(dateSep(m))
    } else if (kind === 'unread') {
      flush()
      nodes.push(unreadDivider())
    } else if (kind === 'system') {
      flush()
      nodes.push(systemNotice(m))
    } else if (kind === 'boundary') {
      flush()
      nodes.push(boundary(m))
    } else if (kind === 'recalled' || kind === 'adminDeleted' || kind === 'pendingDelete') {
      flush()
      nodes.push(notice(m))
    } else {
      const prev = group?.items[group.items.length - 1]
      const gap =
        prev && minutes(m.t) !== null && minutes(prev.t) !== null
          ? minutes(m.t) - minutes(prev.t)
          : 0
      const joinable =
        group && group.from === m.from && gap <= 3 && kind !== 'agent' && prev.k !== 'agent'
      if (joinable) group.items.push(m)
      else {
        flush()
        group = { from: m.from, items: [m], day }
      }
    }
  }
  flush()
  const typing = typingRow()
  if (typing) nodes.push(typing)
  if (state.offline)
    nodes.unshift(
      h(
        'div.banner.banner--warning.banner--sticky',
        { role: 'status', style: { marginBottom: '8px' } },
        icon('wifi-off', 18),
        h('div', '网络已断开。消息不会丢，恢复连接后会自动同步；在此之前它们不会显示为已送达。'),
      ),
    )

  inner.replaceChildren(...nodes)
  // Roving tabindex across messages: the last one is the tab stop.
  const msgs = $$('.msg', inner)
  const last = msgs[msgs.length - 1]
  const refocus = focusedMsg ? msgs.find((m) => m.dataset.msg === focusedMsg) : null
  for (const m of msgs) m.tabIndex = m === (refocus ?? last) ? 0 : -1
  refocus?.focus({ preventScroll: true })

  if (keepScroll && !toBottom) el.scrollTop = previousTop
  else {
    el.scrollTop = el.scrollHeight
    // Layout may still change (composer height, fonts); settle at the bottom once more.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
      updateJump()
    })
  }
  updateJump()
}

let newCount = 0

export function updateJump() {
  const el = ui.timelineEl
  const away = el.scrollHeight - el.scrollTop - el.clientHeight > 120
  let jump = ui.mainEl.querySelector('.jump')
  if (!away) {
    newCount = 0
    jump?.remove()
    return
  }
  if (!jump) {
    jump = h(
      'button.jump.glass-lite',
      {
        type: 'button',
        'aria-label': '回到最新',
        onclick: () => {
          ui.timelineEl.scrollTo({ top: ui.timelineEl.scrollHeight, behavior: 'smooth' })
        },
      },
      icon('arrow-down', 20),
    )
    ui.mainEl.appendChild(jump)
  }
  jump.querySelector('.badge')?.remove()
  if (newCount > 0) jump.appendChild(h('span.badge', { 'aria-hidden': 'true' }, String(newCount)))
  jump.setAttribute('aria-label', newCount ? `回到最新，期间有 ${newCount} 条新消息` : '回到最新')
}

/** Adds a message to a conversation. Scrolls if the reader is at the bottom, otherwise counts it. */
export function appendMessage(convId, m) {
  const list = (messages[convId] ??= [])
  list.push(m)
  const c = conv(convId)
  if (c) {
    c.last = `${m.from === ME ? '' : `${people[m.from]?.name ?? ''}：`}${snippet(m)}`.replace(
      /^：/,
      '',
    )
    c.time = m.t ?? c.time
    if (convId !== state.conv && m.from !== ME) c.unread = (c.unread ?? 0) + 1
    bus.emit('sidebar:refresh')
  }
  if (convId !== state.conv) return
  const el = ui.timelineEl
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  m.isNew = true
  renderTimeline({ keepScroll: true, toBottom: atBottom })
  setTimeout(() => {
    m.isNew = undefined
  }, 0)
  if (!atBottom && m.from !== ME) {
    newCount += 1
    updateJump()
  }
  if (m.from !== ME) announce(`${people[m.from]?.name ?? '助手'}：${snippet(m)}`)
}

export function replaceMessage(convId, id, patch) {
  const list = messages[convId]
  const i = list?.findIndex((m) => m.id === id) ?? -1
  if (i < 0) return
  Object.assign(list[i], patch)
  if (convId === state.conv) renderTimeline({ keepScroll: true, toBottom: false })
}

export function initTimeline() {
  const el = ui.timelineEl
  el.addEventListener('scroll', updateJump, { passive: true })
  // Arrow keys move between messages (roving tabindex); Home/End jump to the ends.
  el.addEventListener('keydown', (event) => {
    const msg = event.target.closest?.('.msg')
    if (!msg || event.target !== msg) return
    const items = $$('.msg', el)
    const i = items.indexOf(msg)
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    let next
    if (step) next = items[clamp(i + step, 0, items.length - 1)]
    else if (event.key === 'Home') next = items[0]
    else if (event.key === 'End') next = items[items.length - 1]
    else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault()
      const r = msg.getBoundingClientRect()
      msg.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 20 }),
      )
      return
    }
    if (!next) return
    event.preventDefault()
    for (const m of items) m.tabIndex = m === next ? 0 : -1
    next.focus()
    next.scrollIntoView({ block: 'nearest' })
  })
  bus.on('conv', () => renderTimeline())
  bus.on('timeline:render', (opts) => renderTimeline(opts))
  bus.on('timeline:append', ({ convId, m }) => appendMessage(convId, m))
  bus.on('conv:open', (id) => selectConversation(id))
  bus.on('timeline:jump', (id) => jumpTo(id))
  bus.on('app:mounted', () => renderTimeline())
  new ResizeObserver(() => updateJump()).observe(el)
}
