// Inspector (docs/02 sections 3 and 6): a Details tab and an Assistant tab.
// The assistant panel is private to the reader and reads only the current conversation unless the
// reader switches to "all my conversations" (D-051); every switch starts a new context segment.

import { bus, state, ui } from './core.js'
import { conv, convTitle, ME, people, quickActions } from './data.js'
import { $, h, icon, rememberFocus, replace, sleep, uid } from './dom.js'
import { renderMarkdown } from './markdown.js'
import { openMenu, toast } from './overlays.js'
import { session } from './toolbar.js'
import {
  avatar,
  badge,
  botBadge,
  button,
  convAvatar,
  iconButton,
  presenceLabel,
  seg,
  switchEl,
} from './widgets.js'

const ROLES = {
  'ch-project': { alice: '群主', bob: '管理员' },
  'ch-design': { alice: '群主' },
  'g-hike': { me: '群主', carol: '管理员' },
  'g-fam': { me: '群主' },
}
const roleOf = (convId, id) => ROLES[convId]?.[id] ?? null
const iAmManager = (convId) => ['群主', '管理员'].includes(roleOf(convId, ME))

const assist = {} // per conversation: { scope, log }
let usage = 12
let restoreOpener = null
let streaming = false

const panel = (convId) => (assist[convId] ??= { scope: 'current', log: [] })

// ---- Details tab ----

function memberRow(c, id) {
  const p = people[id]
  const role = roleOf(c.id, id)
  const row = h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: '10px', minHeight: '44px' } },
    avatar(id, { size: 32, presence: true }),
    h(
      'div',
      { style: { flex: '1', minWidth: '0' } },
      h(
        'div.t-headline.truncate',
        id === ME ? `${p.name}（你）` : p.name,
        role ? h('span.badge.badge--role', { style: { marginLeft: '6px' } }, role) : null,
      ),
      h(
        'div.t-sub.t-secondary.truncate',
        `@${p.username} · ${p.status === 'offline' ? `最后在线 ${p.seen}` : presenceLabel(p.status)}`,
      ),
    ),
    iAmManager(c.id) && id !== ME && roleOf(c.id, id) !== '群主'
      ? iconButton({
          icon: 'ellipsis',
          label: `管理 ${p.name}`,
          'aria-haspopup': 'menu',
          onClick: (event) =>
            openMenu({
              anchor: event.currentTarget,
              placement: 'bottom-end',
              focusFirst: event.detail === 0,
              ariaLabel: `管理 ${p.name}`,
              items: [
                {
                  label: roleOf(c.id, id) ? '取消管理员' : '设为管理员',
                  icon: 'shield-check',
                  onSelect: () => toast('原型：群主可以任免管理员'),
                },
                {
                  label: '禁言…',
                  icon: 'volume-x',
                  onSelect: () => toast('禁言只接受有限的截止时间'),
                },
                { type: 'separator' },
                {
                  label: '移出',
                  icon: 'user-minus',
                  danger: true,
                  onSelect: () => toast(`已将 ${p.name} 移出`),
                },
                {
                  label: '移出并封禁',
                  icon: 'ban',
                  danger: true,
                  onSelect: () => toast(`已将 ${p.name} 移出并封禁，对方无法再加入`),
                },
              ],
            }),
        })
      : null,
  )
  return row
}

function detailsBody() {
  const c = conv(state.conv)
  const body = h('div')

  if (c.kind === 'dm') {
    const p = people[c.person]
    body.append(
      h(
        'div.inspector__section',
        { style: { justifyItems: 'center', textAlign: 'center' } },
        avatar(c.person, { size: 72, presence: true }),
        h('div.t-title-2', p.name),
        h('div.t-sub.t-secondary', `@${p.username}`),
        h('div.t-callout', p.status === 'offline' ? `最后在线 ${p.seen}` : presenceLabel(p.status)),
      ),
      h(
        'div.inspector__section',
        h('div.inspector__h', '会话设置'),
        h('div.rows', settingsRows(c)),
      ),
    )
    return body
  }

  const members = c.members.map((id) => memberRow(c, id))
  body.append(
    h(
      'div.inspector__section',
      { style: { justifyItems: 'center', textAlign: 'center' } },
      convAvatar(c, 56),
      h('div.t-title-2', c.kind === 'channel' ? `# ${c.name}` : c.name),
      c.desc ? h('div.t-callout.t-secondary', c.desc) : null,
    ),
    h(
      'div.inspector__section',
      h(
        'div.inspector__h',
        h('span', `成员（${c.memberCount ?? c.members.length}）`),
        iAmManager(c.id)
          ? iconButton({
              icon: 'user-plus',
              label: '添加成员',
              size: 16,
              cls: 'icon-btn--sm',
              onClick: () => toast('原型：这里会打开添加成员或生成群邀请链接'),
            })
          : null,
      ),
      h('div', members),
      c.memberCount && c.memberCount > c.members.length
        ? button({
            label: `查看全部 ${c.memberCount} 位成员`,
            kind: 'plain',
            size: 'sm',
            onClick: () => toast('原型：这里会展开完整成员列表'),
          })
        : null,
    ),
    h(
      'div.inspector__section',
      h('div.inspector__h', h('span', '共享文件'), h('span.t-foot', 'M3 起')),
      h(
        'div',
        { style: { display: 'grid', gap: '6px' } },
        [
          ['图标草案-v1.fig', '3.2 MiB · Alice Chen'],
          ['评审议程.pdf', '412 KiB · Carol Wu'],
          ['迁移脚本.sql', '3 KiB · Bob Lin'],
        ].map(([name, meta]) =>
          h(
            'button.att-file',
            {
              type: 'button',
              style: { width: '100%' },
              onclick: () => toast(`原型：下载「${name}」`),
            },
            h('span.att-file__icon', icon('file-text', 18)),
            h(
              'span',
              { style: { flex: '1', minWidth: '0' } },
              h('div.att-file__name.truncate', name),
              h('div.att-file__size', meta),
            ),
            icon('download', 16),
          ),
        ),
      ),
    ),
    h('div.inspector__section', h('div.inspector__h', '会话设置'), h('div.rows', settingsRows(c))),
  )
  if (iAmManager(c.id)) {
    body.append(
      h(
        'div.inspector__section',
        h('div.inspector__h', '封禁名单'),
        h(
          'div.row',
          h(
            'div.row__main',
            h('div.row__title', 'Eve Zhang'),
            h('div.row__help', '9月20日 · 被封禁，无法通过邀请链接或被拉入重新加入'),
          ),
          h(
            'div.row__control',
            button({
              label: '解除',
              kind: 'tinted',
              size: 'sm',
              onClick: () => toast('已解除封禁'),
            }),
          ),
        ),
      ),
    )
  }
  return body
}

function settingsRows(c) {
  const rows = []
  const notify = seg({
    label: '通知级别',
    value: 'mentions',
    items: [
      { value: 'all', label: '全部' },
      { value: 'mentions', label: '@我' },
      { value: 'none', label: '关闭' },
    ],
    onChange: (v) => toast(`通知级别：${{ all: '全部', mentions: '仅 @我', none: '关闭' }[v]}`),
  })
  rows.push(
    h(
      'div.row',
      h('div.row__main', h('div.row__title', '置顶')),
      h(
        'div.row__control',
        switchEl({
          checked: Boolean(c.pinned),
          label: '置顶',
          onChange: (on) => ((c.pinned = on), bus.emit('sidebar:refresh')),
        }),
      ),
    ),
    h(
      'div.row',
      h(
        'div.row__main',
        h('div.row__title', '免打扰'),
        h('div.row__help', '关闭、到指定时间、或永久，三种都明确显示'),
      ),
      h(
        'div.row__control',
        switchEl({
          checked: Boolean(c.muted),
          label: '免打扰',
          onChange: (on) => (
            (c.muted = on), bus.emit('sidebar:refresh'), bus.emit('toolbar:refresh')
          ),
        }),
      ),
    ),
    h(
      'div.row',
      { style: { flexWrap: 'wrap' } },
      h('div.row__main', h('div.row__title', '通知级别')),
      h('div.row__control', notify),
    ),
  )
  if (c.kind !== 'dm') {
    rows.push(
      h(
        'div.row',
        h(
          'div.row__main',
          h('div.row__title', '允许 @助手'),
          h('div.row__help', roleOf(c.id, ME) === '群主' ? '只有群主可以关闭' : '由群主设置'),
        ),
        h(
          'div.row__control',
          switchEl({
            checked: Boolean(c.agent),
            label: '允许 @助手',
            onChange: (on) => ((c.agent = on), toast(on ? '已开启 @助手' : '已关闭 @助手')),
          }),
        ),
      ),
    )
  }
  if (c.agent) {
    rows.push(
      h(
        'div.assist__note',
        { style: { marginTop: '8px' } },
        icon('info', 16),
        '@助手 时，最近的消息会发送给 AI 服务处理。',
      ),
    )
  }
  return rows
}

// ---- Assistant tab ----

function typeInto(target, full, onTick) {
  return (async () => {
    let i = 0
    while (i < full.length) {
      i = Math.min(full.length, i + 3)
      target.text = full.slice(0, i)
      onTick()
      await sleep(40 + Math.random() * 25)
    }
  })()
}

const ANSWERS = {
  unread: {
    title: '未读摘要 · 3 条新消息',
    text: '- **许晴** 提到了你：深色气泡对比度实测 5.7，可以过。\n- **助手** 总结了今天的讨论。\n- **Alice** 补充：图标草案下午发。',
    sources: ['许晴 10:05', '助手 10:20', 'Alice Chen 10:31'],
  },
  range: {
    title: '这段讨论的要点',
    text: '- 迁移脚本 `0007_message_seq` 已在空库验证，回滚方案写在 PR 描述里。\n- 周五评审议程已放进文档，大家补充后定稿。\n- 浅色和深色界面各一版，气泡对比度实测 5.7。',
    sources: ['Bob Lin 09:31', 'Carol Wu 09:12'],
  },
  find: {
    title: '找到 12 条相关消息',
    text: '- Bob Lin 09:31：迁移脚本改好了，空库跑一遍没问题\n- Bob Lin 09:32：索引在 `messages(conversation_id, seq)`\n- 周屿 09:40：收到。回滚方案也写一下？',
    sources: [],
  },
  draft: {
    title: '回复草稿',
    text: '收到，我今天下班前把深色模式再对一遍，有问题直接在这里说。',
    draft: true,
    sources: [],
  },
  translate: {
    title: '译文',
    text: 'The migration script is fixed and runs cleanly on an empty database.',
    sources: [],
  },
}

async function ask(kind, prompt) {
  if (streaming) return
  const p = panel(state.conv)
  const answer = ANSWERS[kind] ?? ANSWERS.range
  p.log.push({ id: uid('a'), kind: 'me', text: prompt })
  const card = {
    id: uid('a'),
    kind: 'card',
    title: answer.title,
    text: '',
    sources: [],
    draft: answer.draft,
    done: false,
  }
  p.log.push(card)
  streaming = true
  usage = Math.min(100, usage + 1)
  renderPanelBody()
  await sleep(450)
  await typeInto(card, answer.text, () => {
    if (state.inspector === 'assistant') renderPanelBody({ keepScroll: false })
  })
  card.sources = answer.sources
  card.done = true
  streaming = false
  renderPanelBody()
}

function logNodes(convId) {
  const p = panel(convId)
  return p.log.map((item) => {
    if (item.kind === 'epoch')
      return h('div.epoch-div', { role: 'separator' }, h('span', item.text))
    if (item.kind === 'me') return h('div.a-msg.a-msg--me', h('div.a-msg__me', item.text))
    return h(
      'div.a-msg',
      h(
        'div.a-card',
        { 'aria-busy': item.done ? null : 'true' },
        h('h4', item.title),
        h('div', renderMarkdown(item.text || '…')),
        item.sources?.length
          ? h(
              'div.sources',
              item.sources.map((s) =>
                h(
                  'button.source',
                  { type: 'button', onclick: () => toast('原型：这里会跳到原消息') },
                  icon('text-quote', 14),
                  s,
                ),
              ),
            )
          : null,
        item.done
          ? h(
              'div.a-card__foot',
              item.draft
                ? button({
                    label: '插入输入框',
                    icon: 'corner-down-left',
                    kind: 'filled',
                    size: 'sm',
                    onClick: () => (
                      bus.emit('composer:insert', item.text), toast('已放进输入框，还没有发送')
                    ),
                  })
                : null,
              button({
                label: '复制',
                icon: 'copy',
                kind: 'tinted',
                size: 'sm',
                onClick: () => toast('已复制'),
              }),
            )
          : null,
      ),
    )
  })
}

function assistantBody() {
  const c = conv(state.conv)
  const p = panel(state.conv)
  const wrap = h('div.assist')
  const shared = c.kind === 'channel' || c.kind === 'group'
  if (c.joined && shared) {
    wrap.append(
      h(
        'div.banner.banner--info',
        icon('info', 18),
        h(
          'div',
          `有新成员加入，群内助手现在只总结所有成员都能看到的讨论（从 ${c.joined} 起）。你的个人面板仍按你本人的权限读取。`,
        ),
      ),
    )
  }
  const scope = seg({
    label: '助手读取范围',
    value: p.scope,
    block: true,
    items: [
      { value: 'current', label: '只看当前会话' },
      { value: 'all', label: '我的全部会话' },
    ],
    onChange: (value) => {
      p.scope = value
      p.log.push({
        id: uid('a'),
        kind: 'epoch',
        text: '范围已切换，新对话不会沿用上一范围的上下文',
      })
      renderPanelBody()
    },
  })
  wrap.append(
    h(
      'div.assist__scope',
      h('div.inspector__h', '读取范围'),
      scope,
      h(
        'div.assist__note',
        icon(p.scope === 'all' ? 'triangle-alert' : 'eye', 16),
        p.scope === 'all'
          ? '助手会读取你有权查看的所有会话，包括私信。起草的内容不会自动发出，需要你确认。'
          : '只读取这个会话里你能看到的消息，不会读你的其他会话。',
      ),
    ),
    h(
      'div.assist__chips',
      quickActions.map((a) =>
        h(
          'button.chip',
          { type: 'button', disabled: streaming, onclick: () => ask(a.id, a.prompt) },
          icon(a.icon, 16),
          a.label,
        ),
      ),
    ),
  )
  const log = logNodes(state.conv)
  if (log.length === 0) {
    wrap.append(
      h(
        'div.t-callout.t-secondary',
        { style: { textAlign: 'center', padding: '12px 0' } },
        '只有你能看到这里的对话。试试上面的快捷操作。',
      ),
    )
  } else {
    wrap.append(h('div', { style: { display: 'grid', gap: '12px' } }, log))
  }
  return wrap
}

function assistantFoot() {
  const ta = h('textarea#assist-input', {
    rows: '1',
    'aria-label': '向助手提问',
    placeholder: '向助手提问…',
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        submit()
      }
    },
    oninput: () => {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`
    },
  })
  const submit = () => {
    const text = ta.value.trim()
    if (!text || streaming) return
    ta.value = ''
    ta.style.height = 'auto'
    ask(
      /起草|回复/.test(text)
        ? 'draft'
        : /找|搜索/.test(text)
          ? 'find'
          : /翻译/.test(text)
            ? 'translate'
            : /未读/.test(text)
              ? 'unread'
              : 'range',
      text,
    )
  }
  return h(
    'div',
    {
      style: {
        padding: '10px 14px 14px',
        display: 'grid',
        gap: '10px',
        borderTop: '1px solid var(--separator)',
      },
    },
    h(
      'div.assist__ask',
      ta,
      iconButton({
        icon: 'arrow-up',
        label: '发送给助手',
        cls: 'icon-btn--round icon-btn--filled',
        size: 18,
        onClick: submit,
      }),
    ),
    h(
      'div.assist__foot',
      { style: { border: '0', padding: '0' } },
      session.keySource === 'user'
        ? h(
            'div.meter__row',
            h('span', icon('key-round', 14), ' 正在使用你的 API key'),
            h('span', '不占每日额度'),
          )
        : h(
            'div.meter',
            h(
              'div.meter__row',
              h('span', '今日已用 ', h('b', `${usage}%`)),
              h('span', '明早 00:00 重置'),
            ),
            h(
              'div.meter__bar',
              {
                role: 'progressbar',
                'aria-label': '今日用量',
                'aria-valuenow': String(usage),
                'aria-valuemin': '0',
                'aria-valuemax': '100',
              },
              h('i', { style: { '--v': `${usage}%` } }),
            ),
          ),
    ),
  )
}

// ---- Frame ----

function renderPanelBody({ keepScroll = true } = {}) {
  if (state.inspector !== 'assistant') return
  const body = $('.inspector__body', ui.inspectorEl)
  if (!body) return
  const top = body.scrollTop
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40
  body.replaceChildren(assistantBody())
  const foot = $('.inspector__foot', ui.inspectorEl)
  foot?.replaceChildren(assistantFoot())
  body.scrollTop = atEnd || !keepScroll ? body.scrollHeight : top
}

export function renderInspector() {
  const el = ui.inspectorEl
  const open = state.inspector !== 'closed'
  ui.appEl.dataset.inspector = open ? 'open' : 'closed'
  if (!open) {
    el.replaceChildren()
    return
  }
  const c = conv(state.conv)
  const tabs = seg({
    label: '面板',
    mode: 'tab',
    value: state.inspector,
    block: true,
    items: [
      { value: 'details', label: '详情' },
      ...(c.kind === 'agent' ? [] : [{ value: 'assistant', label: '助手', icon: 'spark' }]),
    ],
    onChange: (value) => bus.emit('inspector:set', value),
  })
  const close = iconButton({
    icon: 'x',
    label: '关闭面板',
    tip: '关闭',
    keys: 'Esc',
    onClick: () => bus.emit('inspector:set', 'closed'),
  })
  el.setAttribute('role', 'complementary')
  replace(
    el,
    h('div.inspector__head', h('div.inspector__head-row', tabs, close)),
    h('div.inspector__body.scroll', { id: 'inspector-body', role: 'tabpanel' }),
    state.inspector === 'assistant' ? h('div.inspector__foot') : null,
  )
  const body = $('.inspector__body', el)
  if (state.inspector === 'assistant') {
    body.replaceChildren(assistantBody())
    $('.inspector__foot', el).replaceChildren(assistantFoot())
    body.scrollTop = body.scrollHeight
  } else {
    body.replaceChildren(detailsBody())
  }
}

function setInspector(value) {
  const previous = state.inspector
  if (value === previous) return
  if (previous === 'closed') restoreOpener = rememberFocus()
  state.inspector = value
  renderInspector()
  bus.emit('inspector', value)
  if (value === 'closed') {
    restoreOpener?.()
    restoreOpener = null
  } else if (previous === 'closed') {
    const target =
      value === 'assistant'
        ? $('#assist-input', ui.inspectorEl)
        : $('[role=tab][aria-selected=true]', ui.inspectorEl)
    target?.focus({ preventScroll: true })
  }
}

export function initInspector() {
  bus.on('inspector:set', setInspector)
  bus.on('conv', () => {
    if (state.inspector === 'assistant' && conv(state.conv).kind === 'agent')
      state.inspector = 'details'
    if (state.inspector === 'closed') return
    renderInspector()
  })
  bus.on('assistant:handoff', (m) => {
    const snippet = (m.text ?? '')
      .replace(/<@user:([\w-]+)>/g, (_, id) => `@${people[id]?.name ?? id}`)
      .slice(0, 40)
    setInspector('assistant')
    renderInspector()
    const ta = $('#assist-input')
    if (ta) {
      ta.value = `关于这条消息：「${snippet}」，帮我起草一条回复`
      ta.focus()
    }
    toast('已把这条消息带进助手面板，只有你能看到')
  })
  bus.on('assistant:ask', ({ kind, prompt }) => {
    if (state.inspector !== 'assistant') setInspector('assistant')
    ask(kind, prompt)
  })
  bus.on('assistant:scope', (scope) => {
    const p = panel(state.conv)
    p.scope = scope
    p.log.push({ id: uid('a'), kind: 'epoch', text: '范围已切换，新对话不会沿用上一范围的上下文' })
    if (state.inspector === 'assistant') renderInspector()
  })
  bus.on('assistant:epoch', (text) => {
    panel(state.conv).log.push({ id: uid('a'), kind: 'epoch', text })
    if (state.inspector === 'assistant') renderInspector()
  })
  ui.inspectorEl.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && getComputedStyle(ui.inspectorEl).position === 'absolute') {
      event.stopPropagation()
      setInspector('closed')
    }
  })
  bus.on('prefs', () => state.inspector === 'assistant' && renderPanelBody())
}

export { badge, botBadge, convTitle }
