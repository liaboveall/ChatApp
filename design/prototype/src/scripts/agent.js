// Agent UI and a scripted stand-in for the model (docs/02 section 6, docs/06).
// Nothing here calls a model: replies are canned and streamed in small chunks, 50-100 ms apart in
// the real app. The point is what the interface does while that happens.

import { bus, state, ui } from './core.js'
import { conv, ME, messages, people } from './data.js'
import { $, h, icon, replace, sleep, uid } from './dom.js'
import { renderMarkdown } from './markdown.js'
import { openDialog, toast } from './overlays.js'
import { botBadge, button, spinner } from './widgets.js'

const mdContext = {
  mention: (id) => h('span.mention', `@${people[id]?.name ?? id}`),
}

let running = null // { convId, msgId, cancelled }

export const isAgentRunning = () => running !== null

// ---- Rendering ----

function appendCaret(nodes) {
  const caret = h('span.caret', { 'aria-hidden': 'true' })
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (node.nodeType === 1 && ['P', 'LI', 'UL', 'OL', 'BLOCKQUOTE'].includes(node.tagName)) {
      let target = node
      while (
        target.lastElementChild &&
        ['UL', 'OL', 'LI', 'P', 'BLOCKQUOTE'].includes(target.lastElementChild.tagName)
      ) {
        target = target.lastElementChild
      }
      target.appendChild(caret)
      return
    }
  }
  nodes.push(caret)
}

function toolCard(block) {
  const open = Boolean(block.open)
  const state = block.state ?? 'done'
  const lead =
    state === 'running'
      ? spinner()
      : state === 'error'
        ? icon('circle-alert', 18)
        : icon('circle-check', 18)
  const title = state === 'running' ? block.running : block.done
  const card = h(
    'div.tool',
    { dataset: { state, open: String(open) } },
    h(
      'button.tool__head',
      {
        type: 'button',
        'aria-expanded': String(open),
        onclick: () => {
          block.open = !block.open
          card.dataset.open = String(block.open)
          head.setAttribute('aria-expanded', String(block.open))
          body.hidden = !block.open
        },
      },
      lead,
      h('span', title),
      icon('chevron-down', 16, 'tool__chev'),
    ),
  )
  const head = card.querySelector('.tool__head')
  const body = h(
    'div.tool__body',
    { hidden: !open },
    block.params
      ? h(
          'dl.tool__kv',
          Object.entries(block.params).flatMap(([k, v]) => [h('dt', k), h('dd', String(v))]),
        )
      : null,
    block.hits?.length
      ? h(
          'div',
          { style: { display: 'grid', gap: '4px' } },
          block.hits.map((t) =>
            h(
              'button.tool__hit',
              { type: 'button', onclick: () => toast('原型：这里会跳到原消息') },
              h('span', t),
            ),
          ),
        )
      : null,
    block.took ? h('div', `耗时 ${block.took}`) : null,
  )
  card.appendChild(body)
  return card
}

function thinkingCard(block) {
  const running = block.state === 'running'
  return h(
    'div.tool',
    { dataset: { state: running ? 'running' : 'done', open: 'false' } },
    h(
      'div.tool__head',
      { style: { cursor: 'default' } },
      running ? spinner() : icon('brain', 18),
      h('span', running ? '正在深度思考…' : `已深度思考 ${block.seconds} 秒`),
    ),
  )
}

export function approvalCard(m, block) {
  const a = block.approval
  const card = h('div.approval.glass-lite', {
    role: 'group',
    'aria-label': '待批准的操作',
    dataset: { state: a.state },
  })
  const draw = () => {
    card.dataset.state = a.state
    const head = h(
      'div.approval__head',
      h(
        'span.approval__icon',
        icon(
          a.state === 'approved'
            ? 'circle-check'
            : a.state === 'rejected' || a.state === 'expired'
              ? 'circle-x'
              : 'shield-check',
          20,
        ),
      ),
      h(
        'div',
        h(
          'div.approval__title',
          a.state === 'approved'
            ? '已批准'
            : a.state === 'rejected'
              ? '已拒绝'
              : a.state === 'expired'
                ? '已过期'
                : '助手想代你发一条消息',
        ),
        h(
          'div.approval__sub',
          a.state === 'pending' || a.state === 'editing'
            ? '这会影响其他人，所以需要你批准'
            : a.state === 'approved'
              ? '消息已发出，标注为「经助手代发」'
              : a.state === 'rejected'
                ? '助手没有发送任何内容'
                : '24 小时内没有批准，操作已取消',
        ),
      ),
    )
    const target = h(
      'div.approval__target',
      h('span.t-secondary', '发送到'),
      h(
        'span.chip',
        { style: { minHeight: '26px', pointerEvents: 'none' } },
        icon('hash', 16),
        a.target,
      ),
      h('span.t-secondary', `· ${a.audience}`),
    )
    let preview
    if (a.state === 'editing') {
      const ta = h('textarea.textarea#approval-body', {
        'aria-label': '修改要发送的内容',
        value: a.body,
      })
      preview = h(
        'div.approval__preview',
        h('label.approval__preview-label', { for: 'approval-body' }, '修改后发送的内容'),
        ta,
      )
      card.__ta = ta
    } else {
      preview = h(
        'div.approval__preview',
        h('div.approval__preview-label', '将要发送的完整内容'),
        h('div', renderMarkdown(a.body, mdContext)),
      )
    }
    const impact =
      a.state === 'pending' || a.state === 'editing'
        ? h(
            'div.approval__impact',
            icon('users', 16),
            `${a.audience}会看到这条消息，发出后不能自动收回。`,
          )
        : null
    let foot
    if (a.state === 'pending') {
      foot = h(
        'div.approval__foot',
        h('span.approval__time', icon('clock', 16), `剩余有效时间 ${a.left}`),
        button({ label: '拒绝', kind: 'plain', danger: true, onClick: () => decide('rejected') }),
        button({ label: '修改', kind: 'tinted', onClick: () => ((a.state = 'editing'), draw()) }),
        button({ label: '批准并发送', kind: 'filled', onClick: () => decide('approved') }),
      )
    } else if (a.state === 'editing') {
      foot = h(
        'div.approval__foot',
        h('span.approval__time', icon('clock', 16), `剩余有效时间 ${a.left}`),
        button({
          label: '取消修改',
          kind: 'plain',
          onClick: () => ((a.state = 'pending'), draw()),
        }),
        button({
          label: '保存并批准',
          kind: 'filled',
          onClick: () => ((a.body = card.__ta.value.trim() || a.body), decide('approved')),
        }),
      )
    } else {
      foot = null
    }
    replace(card, head, target, preview, impact, foot)
    if (a.state === 'editing') card.__ta?.focus()
  }
  function decide(result) {
    a.state = result
    draw()
    bus.emit('agent:approval', { msg: m, block, result })
  }
  draw()
  return card
}

function taskCard(block) {
  const t = block.task
  const canceled = t.state === 'canceled'
  const card = h(
    'div.task-card',
    { role: 'group', 'aria-label': t.kind === 'schedule' ? '定时消息' : '提醒' },
    h(
      'div.task-card__head',
      h('span.task-card__icon', icon(t.kind === 'schedule' ? 'calendar-clock' : 'alarm-clock', 18)),
      h(
        'div',
        h('div.t-headline', t.title),
        h(
          'div.t-sub.t-secondary',
          canceled ? '已取消' : t.kind === 'schedule' ? '定时消息 · 已安排' : '提醒 · 已设置',
        ),
      ),
    ),
    h(
      'dl.kv',
      h('dt', '日期'),
      h('dd', t.date),
      h('dt', '时区'),
      h('dd', `${t.tz}（${t.offset}）`),
      h('dt', '来源设备'),
      h('dd', t.device),
      t.where ? [h('dt', '发送到'), h('dd', t.where)] : null,
    ),
    canceled
      ? null
      : h(
          'div.task-card__foot',
          h('span.t-sub.t-secondary', '修改时区只改变显示，不改变已约定的时刻'),
          button({
            label: '取消',
            kind: 'tinted',
            size: 'sm',
            onClick: () => (
              (t.state = 'canceled'),
              bus.emit('timeline:render', { keepScroll: true, toBottom: false }),
              toast('已取消，之后需要的话可以重新设置')
            ),
          }),
        ),
  )
  return card
}

function dstCard(block) {
  const missing = block.variant === 'missing'
  const name = uid('dst')
  let chosen = null
  const confirm = button({
    label: '确认这个时间',
    kind: 'filled',
    size: 'sm',
    disabled: true,
    onClick: () => toast(`已确认：${chosen}`),
  })
  const options = missing
    ? [
        ['2027年3月14日 03:30（EDT，UTC−04:00）', '改到 03:30'],
        ['2027年3月14日 01:30（EST，UTC−05:00）', '改到 01:30'],
      ]
    : [
        ['第一次 01:30 · 夏令时 EDT（UTC−04:00）', 'UTC 05:30'],
        ['第二次 01:30 · 标准时间 EST（UTC−05:00）', 'UTC 06:30'],
      ]
  return h(
    'div.task-card',
    { role: 'group', 'aria-label': missing ? '这个时间不存在' : '这个时间出现两次' },
    h(
      'div.task-card__head',
      h(
        'span.task-card__icon',
        {
          style: {
            background: 'color-mix(in srgb, var(--warning-solid) 16%, transparent)',
            color: 'var(--warning-text)',
          },
        },
        icon('triangle-alert', 18),
      ),
      h(
        'div',
        h(
          'div.t-headline',
          missing ? '2027年3月14日 02:30 不存在' : '2026年11月1日 01:30 会出现两次',
        ),
        h(
          'div.t-sub.t-secondary',
          `时区 America/New_York · ${missing ? '时钟从 02:00 直接跳到 03:00' : '时钟在 02:00 拨回 01:00'}`,
        ),
      ),
    ),
    h(
      'p.t-callout',
      missing ? '请另选一个时间，不会自动替你挑。' : '请选择你指的是哪一次。确认前不会创建任务。',
    ),
    h(
      'div',
      { role: 'radiogroup', 'aria-label': '选择时间', style: { display: 'grid', gap: '2px' } },
      options.map(([label, note]) =>
        h(
          'label.check',
          h('input', {
            type: 'radio',
            name,
            onchange: () => (
              (chosen = label), (confirm.disabled = false), confirm.removeAttribute('aria-disabled')
            ),
          }),
          h('span', label, h('span.t-sub.t-secondary', { style: { marginLeft: '8px' } }, note)),
        ),
      ),
    ),
    h('div.task-card__foot', h('span.t-sub.t-secondary', '确认后会冻结所选的时刻'), confirm),
  )
}

function memoryChip(block) {
  const undone = block.undone
  return h(
    'div.mem-chip',
    { role: 'status' },
    icon('brain', 16),
    h('span', undone ? '已撤销记忆' : `已记住：${block.text}`),
    undone
      ? null
      : button({
          label: '撤销',
          kind: 'plain',
          onClick: () => {
            block.undone = true
            bus.emit('timeline:render', { keepScroll: true, toBottom: false })
            toast('已撤销，这条记忆已删除')
          },
        }),
  )
}

function errorBlock(block) {
  return h(
    'div.banner.banner--danger',
    { role: 'alert', style: { maxWidth: '460px' } },
    icon('circle-alert', 18),
    h(
      'div',
      h('div', { style: { fontWeight: '600' } }, block.title),
      h('div.t-sub.t-secondary', block.text),
      block.action
        ? h(
            'div',
            { style: { marginTop: '8px' } },
            button({
              label: block.action,
              kind: 'tinted',
              size: 'sm',
              onClick: switchToSiteDialog,
            }),
          )
        : null,
    ),
  )
}

export function switchToSiteDialog() {
  openDialog({
    title: '使用站点额度发起新请求',
    body: [
      h(
        'p',
        '这会新开一段对话。你之前和助手的私有内容、图片和记忆不会自动带过去，需要的话请重新输入。',
      ),
      h(
        'p',
        { style: { marginTop: '8px' } },
        '使用站点额度时，运行内容在保留期内可被站点管理员查看。',
        h(
          'a',
          { href: '#', onclick: (e) => (e.preventDefault(), toast('原型：这里会打开隐私说明')) },
          '查看隐私说明',
        ),
      ),
    ],
    actions: [
      { label: '取消', kind: 'plain', autofocus: true },
      {
        label: '新开对话',
        kind: 'filled',
        onClick: () => toast('已新开对话段，请重新输入你的问题'),
      },
    ],
  })
}

/** Nodes for the message column of an agent message. */
export function renderAgentMessage(m, { last } = {}) {
  const out = []
  const streaming = m.state === 'streaming'
  const waiting = m.state === 'waiting'
  const blocks = m.blocks ?? []
  const lastTextIndex = blocks.reduce((acc, b, i) => (b.type === 'text' ? i : acc), -1)
  blocks.forEach((block, i) => {
    switch (block.type) {
      case 'thinking':
        out.push(thinkingCard(block))
        break
      case 'tool':
        out.push(toolCard(block))
        break
      case 'text': {
        const isLastText = i === lastTextIndex
        const nodes = renderMarkdown(block.text, mdContext)
        const live = streaming && isLastText
        if (live) appendCaret(nodes)
        const tail = last && i === blocks.length - 1
        const bubble = h(
          `div.bubble.bubble--agent${tail ? '.bubble--tail' : ''}${live ? '.is-streaming' : ''}`,
          { 'aria-busy': live ? 'true' : null },
          live
            ? [
                h('span.glow-halo', { 'aria-hidden': 'true' }),
                h('span.glow-ring', { 'aria-hidden': 'true' }),
              ]
            : null,
          nodes,
          waiting && isLastText
            ? h('div.agent-wait', icon('clock', 16), h('span', '等待 ', h('b', '@周屿'), ' 批准'))
            : null,
        )
        out.push(bubble)
        break
      }
      case 'sources':
        out.push(
          h(
            'div.sources',
            { 'aria-label': '参考的消息' },
            block.items.map((s) =>
              h(
                'button.source',
                { type: 'button', onclick: () => toast('原型：这里会跳到原消息') },
                icon('text-quote', 14),
                s,
              ),
            ),
          ),
        )
        break
      case 'approval':
        out.push(approvalCard(m, block))
        break
      case 'memory':
        out.push(memoryChip(block))
        break
      case 'task':
        out.push(taskCard(block))
        break
      case 'dst':
        out.push(dstCard(block))
        break
      case 'error':
        out.push(errorBlock(block))
        break
      default:
        break
    }
  })
  return out
}

// ---- Streaming simulation ----

function pickScript(prompt, kind) {
  const p = prompt.toLowerCase()
  if (/提醒/.test(p)) return 'remind'
  if (/记住|别忘了|remember/.test(p)) return 'remember'
  if (/(说一声|发到|发送|通知|转告).*(项目组|频道|大家)|在\s*#?项目组/.test(p)) return 'send'
  if (/翻译|translate/.test(p)) return 'translate'
  if (/找|搜索|search/.test(p)) return 'search'
  if (/总结|摘要|summar/.test(p)) return kind === 'channel' ? 'summary-channel' : 'summary'
  return 'generic'
}

const SCRIPTS = {
  summary: {
    tool: {
      running: '正在读取未读消息…',
      done: '读取了 #项目组 的 17 条消息',
      params: { conversation: '#项目组', range: '今天 09:12 起', limit: 300 },
      hits: [
        'Bob Lin：迁移脚本改好了，空库跑一遍没问题',
        'Carol Wu：周五评审的议程我放在文档里了',
        '许晴：深色的气泡对比度我测了，蓝色那组是 5.7',
      ],
      took: '1.4 秒',
    },
    text: '今天 #项目组 的要点：\n- **迁移**：Bob 改好了 `0007_message_seq`，空库验证通过，回滚方案在 PR 描述里。\n- **评审**：周五评审的议程在文档里，等大家补充。\n- **设计**：深色气泡对比度实测 5.7，通过。\n- **待办**：提交上周周报，下午会有图标草案。',
    sources: ['Bob Lin 09:31', 'Carol Wu 09:12', '许晴 10:05'],
  },
  'summary-channel': {
    tool: null,
    text: '今天讨论的要点：\n- **迁移**：Bob 改好了 `0007_message_seq`，空库验证通过。\n- **评审**：周五评审议程在文档里。\n- **设计**：浅色和深色各一版已发出，气泡对比度实测 5.7。',
    sources: [],
  },
  search: {
    tool: {
      running: '正在搜索消息…',
      done: '找到 12 条相关消息',
      params: { query: '迁移脚本', scope: '当前会话', limit: 20 },
      hits: [
        'Bob Lin 09:31：迁移脚本改好了，空库跑一遍没问题',
        'Bob Lin 09:32：索引在 messages(conversation_id, seq)',
        '周屿 09:40：收到。回滚方案也写一下？',
      ],
      took: '0.8 秒',
    },
    text: '找到 12 条和「迁移脚本」有关的消息，最相关的是 Bob 今天 09:31 的那条。展开上面的卡片可以看到命中的几条。',
    sources: [],
  },
  translate: {
    tool: null,
    text: 'Here is the English version:\n\n> The migration script is fixed and runs cleanly on an empty database. Please add a rollback plan to the PR description.',
    sources: [],
  },
  generic: {
    tool: null,
    text: '好的。这是一个演示用的回复：真实的助手会在这里根据你的问题读取会话、调用工具并流式输出。\n\n你可以试试「总结今天 #项目组 的讨论」或「在 #项目组 说一声：周五评审改到 15:00」。',
    sources: [],
  },
}

function newAgentMessage(convId, extra = {}) {
  const c = conv(convId)
  const m = {
    id: uid('ag'),
    from: 'bot',
    k: 'agent',
    t: '10:42',
    state: 'streaming',
    blocks: [],
    mode: 'fast',
    ...extra,
  }
  bus.emit('timeline:append', { convId, m })
  if (c) c.last = '助手正在回复…'
  return m
}

function refresh(convId, m) {
  if (convId !== state.conv) return
  const node = ui.timelineEl.querySelector(`[data-msg="${m.id}"]`)
  if (!node) {
    bus.emit('timeline:render', { keepScroll: true, toBottom: true })
    return
  }
  const el = ui.timelineEl
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  const col = node.querySelector('.msg__col')
  const isLast = true
  col.replaceChildren(...renderAgentMessage(m, { last: isLast }))
  if (atBottom) el.scrollTop = el.scrollHeight
}

async function typeInto(convId, m, block, full, ctl) {
  let i = 0
  while (i < full.length) {
    if (ctl.cancelled) return false
    const step = 2 + Math.floor(Math.random() * 3)
    i = Math.min(full.length, i + step)
    block.text = full.slice(0, i)
    refresh(convId, m)
    await sleep(52 + Math.random() * 28)
  }
  return true
}

/** Runs the scripted reply for `prompt` in conversation `convId` (an Agent session or a shared channel). */
export async function runAgent({ convId, prompt, mode = 'fast' }) {
  if (running) return
  const c = conv(convId)
  const kind = c.kind
  const scriptName = pickScript(prompt, kind)
  const ctl = { convId, cancelled: false }
  running = ctl
  bus.emit('agent:state', { running: true })
  const m = newAgentMessage(convId, { mode, scope: null })
  ctl.msgId = m.id
  const shared = kind === 'channel' || kind === 'group'
  await sleep(500)
  if (mode === 'deep') {
    const think = { type: 'thinking', state: 'running', seconds: 6 }
    m.blocks.push(think)
    refresh(convId, m)
    await sleep(1400)
    think.state = 'done'
    refresh(convId, m)
  }

  const finish = (state = 'done') => {
    m.state = state
    m.canRegenerate =
      state === 'done' &&
      !shared &&
      scriptName !== 'send' &&
      scriptName !== 'remind' &&
      scriptName !== 'remember'
    if (shared) m.scope = '只读取了本会话里所有当前成员都能看到的消息'
    refresh(convId, m)
    running = null
    bus.emit('agent:state', { running: false })
    if (c) c.last = '助手：已回复'
    bus.emit('sidebar:refresh')
  }

  if (scriptName === 'send') {
    const intro = { type: 'text', text: '' }
    m.blocks.push(intro)
    if (
      !(await typeInto(
        convId,
        m,
        intro,
        '好的，我准备了一条消息。因为会发给 #项目组 的其他人，需要你批准后才会发送。',
        ctl,
      ))
    )
      return finish('stopped')
    m.blocks.push({
      type: 'approval',
      approval: {
        id: uid('apr'),
        state: 'pending',
        target: '项目组',
        audience: '128 位成员',
        body: '周五评审改到 **15:00**，议程见文档，请大家提前补充。',
        left: '23 小时 41 分',
      },
    })
    m.state = 'waiting'
    refresh(convId, m)
    running = null
    bus.emit('agent:state', { running: false })
    if (c) c.last = '我准备了一条消息，等你批准'
    bus.emit('sidebar:refresh')
    return
  }

  if (scriptName === 'remind') {
    const intro = { type: 'text', text: '' }
    m.blocks.push(intro)
    if (!(await typeInto(convId, m, intro, '好的，已经为你设置好提醒：', ctl)))
      return finish('stopped')
    m.blocks.push({
      type: 'task',
      task: {
        kind: 'reminder',
        title: '提交上周周报',
        date: '2026年10月3日 周六 09:00',
        tz: 'Asia/Shanghai',
        offset: 'UTC+08:00',
        device: 'Windows · Edge 154（此设备）',
        state: 'active',
      },
    })
    refresh(convId, m)
    await sleep(300)
    return finish()
  }

  if (scriptName === 'remember') {
    const intro = { type: 'text', text: '' }
    m.blocks.push(intro)
    if (
      !(await typeInto(
        convId,
        m,
        intro,
        '好的，我记住了。以后可以随时在「设置 → 助手」里查看和删除。',
        ctl,
      ))
    )
      return finish('stopped')
    m.blocks.push({
      type: 'memory',
      text: prompt.replace(/^.*?(记住|别忘了)[：:，,\s]*/, '').slice(0, 60) || '每周五要提交周报',
    })
    refresh(convId, m)
    return finish()
  }

  const script = SCRIPTS[scriptName]
  if (script.tool) {
    const tool = {
      type: 'tool',
      state: 'running',
      running: script.tool.running,
      done: script.tool.done,
      params: script.tool.params,
      hits: script.tool.hits,
      took: script.tool.took,
    }
    m.blocks.push(tool)
    refresh(convId, m)
    await sleep(1100)
    if (ctl.cancelled) return finish('stopped')
    tool.state = 'done'
    refresh(convId, m)
    await sleep(250)
  }
  const text = { type: 'text', text: '' }
  m.blocks.push(text)
  if (!(await typeInto(convId, m, text, script.text, ctl))) return finish('stopped')
  if (script.sources.length > 0) m.blocks.push({ type: 'sources', items: script.sources })
  return finish()
}

export function stopAgent() {
  if (!running) return
  running.cancelled = true
}

function onApproval({ msg, block, result }) {
  const convId = state.conv
  if (result === 'approved') {
    const body = block.approval.body
    bus.emit('timeline:append', {
      convId: 'ch-project',
      m: { id: uid('via'), from: ME, t: '10:43', text: body, via: true },
    })
    toast('已发送到 #项目组，标注为「经助手代发」', {
      action: '查看',
      onAction: () => bus.emit('conv:open', 'ch-project'),
    })
    msg.state = 'done'
    const next = newAgentMessage(convId, { state: 'streaming' })
    const text = { type: 'text', text: '' }
    next.blocks.push(text)
    refresh(convId, next)
    ;(async () => {
      const ctl = { convId, cancelled: false }
      running = ctl
      await typeInto(
        convId,
        next,
        text,
        '已经发送到 #项目组。需要我在周五评审前一小时再提醒大家一次吗？',
        ctl,
      )
      next.state = 'done'
      refresh(convId, next)
      running = null
    })()
  } else if (result === 'rejected') {
    msg.state = 'done'
    const next = newAgentMessage(convId, {
      state: 'done',
      blocks: [{ type: 'text', text: '好的，我没有发送。需要的话，告诉我怎么改，我再准备一条。' }],
    })
    refresh(convId, next)
  }
  refresh(convId, msg)
}

export function initAgent() {
  bus.on('agent:run', runAgent)
  bus.on('agent:stop', stopAgent)
  bus.on('agent:approval', onApproval)
  bus.on('agent:regenerate', (m) => {
    // Regenerate replaces the reply in place (D-036); only the initiator, only the latest reply.
    const list = messages[state.conv]
    const i = list.findIndex((x) => x.id === m.id)
    if (i < 0) return
    list.splice(i, 1)
    bus.emit('timeline:render', { keepScroll: true, toBottom: true })
    const prompt = [...list].reverse().find((x) => x.from === ME && x.text)?.text ?? ''
    runAgent({ convId: state.conv, prompt })
    toast('正在重新生成，新回复会替换原回复')
  })
}

export { $, botBadge }
