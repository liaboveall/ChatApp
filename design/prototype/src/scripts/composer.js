// Composer (docs/02 section 3): floating glass capsule with attach, emoji, @assistant, send.
// Enter sends, Shift+Enter breaks the line, and while an input method is composing, Enter only
// confirms the candidate (D-050).

import { isAgentRunning } from './agent.js'
import { bus, keycap, state, ui } from './core.js'
import { conv, convTitle, emojis, ME, messages, people } from './data.js'
import { h, icon, sleep, uid } from './dom.js'
import { openMenu, placeNear, toast } from './overlays.js'
import { session } from './toolbar.js'
import { avatar, iconButton } from './widgets.js'

const LIMIT = 5000
const drafts = {}
let replyTo = null
let editing = null
let composing = false
let lastCompositionEnd = 0
let mentionMap = {} // "@Alice Chen" -> "alice"
let chips = [] // pending attachments { id, name, size, kind, progress }
let mentionPop = null
let mentionIndex = 0

let el = {}

const trimMd = (s) =>
  s.replace(/[*`~]/g, '').replace(/<@user:([\w-]+)>/g, (_, id) => `@${people[id]?.name ?? id}`)

function placeholder() {
  const c = conv(state.conv)
  if (!c) return '发消息'
  if (c.kind === 'agent') return '向助手提问，Enter 发送'
  if (c.kind === 'dm') return `发消息给 ${convTitle(c)}`
  if (c.kind === 'channel') return `发消息到 # ${c.name}`
  return `发消息到 ${c.name}`
}

function autosize() {
  const ta = el.input
  const max = Math.round((ui.windowEl.clientHeight || 800) * 0.4)
  ta.style.height = 'auto'
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`
  ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden'
}

function updateSend() {
  const text = el.input.value.trim()
  const running = isAgentRunning()
  const send = el.send
  if (running) {
    send.disabled = false
    send.replaceChildren(icon('circle-stop', 20))
    send.setAttribute('aria-label', '停止生成')
    send.setAttribute('data-tip', '停止生成')
    send.classList.add('icon-btn--filled')
    return
  }
  send.replaceChildren(icon('arrow-up', 20))
  send.setAttribute('aria-label', '发送')
  send.setAttribute('data-tip', '发送')
  send.setAttribute('data-tip-keys', 'Enter')
  send.disabled = !(text.length > 0 || chips.some((c) => c.progress >= 100))
  const over = el.input.value.length
  el.count.hidden = over < LIMIT - 500
  if (!el.count.hidden) {
    el.count.textContent = over > LIMIT ? `超出 ${over - LIMIT} 字` : `还可输入 ${LIMIT - over} 字`
    el.count.style.color = over > LIMIT ? 'var(--danger-text)' : 'var(--label-secondary)'
    if (over > LIMIT) send.disabled = true
  }
}

function renderContext() {
  const bar = el.ctx
  bar.replaceChildren()
  bar.hidden = !(replyTo || editing)
  if (bar.hidden) return
  if (editing) {
    bar.append(
      h('span.composer__ctx-bar'),
      h(
        'span.composer__ctx-text',
        h('b', '编辑消息'),
        h('span.truncate', { style: { display: 'block' } }, trimMd(editing.text ?? '')),
      ),
      iconButton({
        icon: 'x',
        label: '取消编辑',
        tip: '取消编辑',
        keys: 'Esc',
        onClick: cancelContext,
      }),
    )
  } else {
    const name = replyTo.from === ME ? '自己' : people[replyTo.from].name
    bar.append(
      h('span.composer__ctx-bar'),
      h(
        'span.composer__ctx-text',
        h('b', `回复 ${name}`),
        h(
          'span.truncate',
          { style: { display: 'block' } },
          trimMd(replyTo.text ?? (replyTo.k === 'images' ? '[图片]' : '')),
        ),
      ),
      iconButton({
        icon: 'x',
        label: '取消回复',
        tip: '取消回复',
        keys: 'Esc',
        onClick: cancelContext,
      }),
    )
  }
}

function renderChips() {
  el.chips.hidden = chips.length === 0
  el.chips.replaceChildren(
    ...chips.map((c) =>
      h(
        'div.upload',
        {
          style: { width: '220px' },
          role: 'group',
          'aria-label': `${c.name}，${c.progress >= 100 ? '已上传' : `上传中 ${Math.round(c.progress)}%`}`,
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          icon(c.kind === 'image' ? 'image' : 'file-text', 16),
          h('span.truncate.t-callout', { style: { flex: '1' } }, c.name),
          iconButton({
            icon: 'x',
            label: `移除 ${c.name}`,
            tip: '移除',
            size: 16,
            cls: 'icon-btn--sm',
            onClick: () => (
              (chips = chips.filter((x) => x.id !== c.id)), renderChips(), updateSend()
            ),
          }),
        ),
        h(
          'div.progress',
          {
            role: 'progressbar',
            'aria-valuenow': String(Math.round(c.progress)),
            'aria-valuemin': '0',
            'aria-valuemax': '100',
          },
          h('i', { style: { '--v': `${c.progress}%` } }),
        ),
        h(
          'div.t-sub.t-secondary',
          c.progress >= 100
            ? `${c.size} · 上传完成`
            : `${c.size} · 上传中 ${Math.round(c.progress)}%`,
        ),
      ),
    ),
  )
}

async function addChip(kind) {
  const chip =
    kind === 'image'
      ? { id: uid('up'), name: '参考图.png', size: '1.8 MiB', kind, progress: 0 }
      : { id: uid('up'), name: '设计稿-v3.pdf', size: '2.4 MiB', kind, progress: 0 }
  chips.push(chip)
  renderChips()
  updateSend()
  for (let p = 0; p < 100; p += 12) {
    await sleep(120)
    if (!chips.includes(chip)) return
    chip.progress = Math.min(100, chip.progress + 12)
    renderChips()
  }
  chip.progress = 100
  renderChips()
  updateSend()
}

function cancelContext() {
  replyTo = null
  if (editing) el.input.value = drafts[state.conv] ?? ''
  editing = null
  renderContext()
  autosize()
  updateSend()
  el.input.focus()
}

function toTokens(text) {
  let out = text
  for (const [display, id] of Object.entries(mentionMap))
    out = out.split(display).join(`<@user:${id}>`)
  return out
}

function send() {
  if (isAgentRunning()) {
    bus.emit('agent:stop')
    return
  }
  const raw = el.input.value.trim()
  const c = conv(state.conv)
  const readyChips = chips.filter((x) => x.progress >= 100)
  if (!raw && readyChips.length === 0) return
  if (el.input.value.length > LIMIT) return

  if (editing) {
    const list = messages[state.conv]
    const target = list.find((m) => m.id === editing.id)
    if (target) {
      target.text = toTokens(raw)
      target.edited = true
    }
    editing = null
    renderContext()
    el.input.value = drafts[state.conv] ?? ''
    autosize()
    updateSend()
    bus.emit('timeline:render', { keepScroll: true, toBottom: false })
    toast('已保存。编辑不会重新触发助手，也不会产生新的通知')
    return
  }

  const text = toTokens(raw)
  const now = '10:44'
  for (const chip of readyChips) {
    bus.emit('timeline:append', {
      convId: state.conv,
      m:
        chip.kind === 'image'
          ? {
              id: uid('m'),
              from: ME,
              t: now,
              k: 'images',
              att: [{ scene: 'mountains', alt: chip.name }],
            }
          : {
              id: uid('m'),
              from: ME,
              t: now,
              k: 'file',
              att: [{ name: chip.name, size: chip.size }],
            },
    })
  }
  chips = []
  renderChips()
  let msg = null
  if (raw) {
    msg = { id: uid('m'), from: ME, t: now, text, state: state.offline ? 'sending' : 'sending' }
    if (replyTo) msg.reply = replyTo.id
    bus.emit('timeline:append', { convId: state.conv, m: msg })
    if (!state.offline) {
      setTimeout(() => {
        msg.state = undefined
        bus.emit('timeline:render', { keepScroll: true, toBottom: false })
      }, 650)
    }
  }
  replyTo = null
  el.input.value = ''
  delete drafts[state.conv]
  mentionMap = {}
  renderContext()
  closeMentions()
  autosize()
  updateSend()

  if (raw) respond(c, raw, text)
}

/** Stand-in for the other side: a typing indicator, then a short reply. */
async function respond(c, raw, text) {
  const asksAgent = c.kind === 'agent' || text.includes('<@user:bot>')
  if (asksAgent) {
    bus.emit('agent:run', { convId: c.id, prompt: raw, mode: session.mode })
    return
  }
  // "quiet" silences the simulated people, not the assistant (the automated checks rely on that).
  if (state.quiet) return
  const who = c.kind === 'dm' ? c.person : (c.members.filter((id) => id !== ME)[0] ?? 'alice')
  const replies = {
    'dm-alice': '收到，我晚点把导出的图标发给你',
    'ch-project': '好的，我看一下',
    default: '收到 👍',
  }
  await sleep(1100)
  if (state.conv === c.id) {
    state.typing = [who]
    bus.emit('timeline:render', { keepScroll: true, toBottom: true })
  }
  await sleep(1700)
  state.typing = null
  bus.emit('timeline:append', {
    convId: c.id,
    m: { id: uid('m'), from: who, t: '10:45', text: replies[c.id] ?? replies.default },
  })
}

// ---- Mentions ----

function mentionCandidates(query) {
  const c = conv(state.conv)
  const ids = [...(c.members ?? []).filter((id) => id !== ME)]
  const list = ids.map((id) => ({ id, name: people[id].name, sub: `@${people[id].username}` }))
  if (c.agent) list.push({ id: 'bot', name: '助手', sub: '机器人 · 会读取本会话并回复', bot: true })
  const q = query.toLowerCase()
  return list.filter(
    (x) => !q || x.name.toLowerCase().includes(q) || x.sub.toLowerCase().includes(q),
  )
}

function closeMentions() {
  mentionPop?.remove()
  mentionPop = null
  el.input?.setAttribute('aria-expanded', 'false')
}

function openMentions(query, start) {
  const items = mentionCandidates(query)
  if (items.length === 0) return closeMentions()
  mentionIndex = Math.min(mentionIndex, items.length - 1)
  mentionPop?.remove()
  const list = h(
    'div.pop.pop--mention.glass-text',
    { role: 'listbox', 'aria-label': '提及' },
    items.map((p, i) =>
      h(
        'button.person',
        {
          type: 'button',
          role: 'option',
          'aria-selected': String(i === mentionIndex),
          dataset: { active: String(i === mentionIndex) },
          onpointerdown: (e) => e.preventDefault(),
          onclick: () => insertMention(p, start),
        },
        avatar(p.id, { size: 28 }),
        h('span', h('div.person__name', p.name), h('div.person__sub', p.sub)),
      ),
    ),
  )
  ui.overlayEl.appendChild(list)
  placeNear(list, el.capsule, { placement: 'top-start', gap: 8 })
  mentionPop = list
  mentionPop.__items = items
  mentionPop.__start = start
  el.input.setAttribute('aria-expanded', 'true')
}

function insertMention(p, start) {
  const ta = el.input
  const caret = ta.selectionStart
  const token = `@${p.name}`
  ta.value = `${ta.value.slice(0, start)}${token} ${ta.value.slice(caret)}`
  const pos = start + token.length + 1
  ta.setSelectionRange(pos, pos)
  mentionMap[token] = p.id
  closeMentions()
  ta.focus()
  autosize()
  updateSend()
}

function checkMention() {
  const ta = el.input
  const before = ta.value.slice(0, ta.selectionStart)
  const m = /(^|\s)@([^\s@]{0,20})$/.exec(before)
  if (!m || conv(state.conv).kind === 'agent') return closeMentions()
  openMentions(m[2], before.length - m[2].length - 1)
}

// ---- Wiring ----

function onKeyDown(event) {
  const ta = el.input
  if (mentionPop) {
    const items = mentionPop.__items
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      mentionIndex =
        (mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      openMentions(
        /@([^\s@]*)$/.exec(ta.value.slice(0, ta.selectionStart))?.[1] ?? '',
        mentionPop.__start,
      )
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (event.isComposing || composing) return
      event.preventDefault()
      insertMention(items[mentionIndex], mentionPop.__start)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMentions()
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    // Input methods use Enter to confirm a candidate. Safari fires compositionend before that keydown.
    const justEnded = performance.now() - lastCompositionEnd < 40
    if (event.isComposing || event.keyCode === 229 || composing || justEnded) return
    event.preventDefault()
    send()
    return
  }
  if (event.key === 'Escape' && (replyTo || editing)) {
    event.preventDefault()
    event.stopPropagation()
    cancelContext()
    return
  }
  if (event.key === 'ArrowUp' && ta.value === '' && !editing && !event.isComposing) {
    const list = messages[state.conv] ?? []
    const mine = [...list].reverse().find((m) => m.from === ME && m.text && !m.k)
    if (mine) {
      event.preventDefault()
      startEdit(mine)
    }
  }
}

function startEdit(m) {
  drafts[state.conv] = el.input.value
  editing = m
  replyTo = null
  el.input.value = (m.text ?? '').replace(
    /<@user:([\w-]+)>/g,
    (_, id) => `@${people[id]?.name ?? id}`,
  )
  renderContext()
  autosize()
  updateSend()
  el.input.focus()
  el.input.setSelectionRange(el.input.value.length, el.input.value.length)
}

function showEmoji(anchor) {
  const pop = h(
    'div.pop.pop--emoji.glass-text',
    { role: 'dialog', 'aria-label': '表情' },
    h(
      'div.emoji-grid',
      emojis.map((e) =>
        h('button', { type: 'button', 'aria-label': e, onclick: () => (insert(e), close()) }, e),
      ),
    ),
  )
  const close = () => {
    pop.remove()
    document.removeEventListener('pointerdown', outside, true)
    anchor.focus()
  }
  const outside = (event) => {
    if (!pop.contains(event.target) && !anchor.contains(event.target)) {
      pop.remove()
      document.removeEventListener('pointerdown', outside, true)
    }
  }
  pop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  })
  ui.overlayEl.appendChild(pop)
  placeNear(pop, el.capsule, { placement: 'top-start', gap: 8 })
  document.addEventListener('pointerdown', outside, true)
  pop.querySelector('button').focus()
}

function insert(text) {
  const ta = el.input
  const s = ta.selectionStart
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(ta.selectionEnd)
  ta.setSelectionRange(s + text.length, s + text.length)
  ta.focus()
  autosize()
  updateSend()
}

export function renderComposer() {
  const c = conv(state.conv)
  ui.composerSlotEl.hidden = !c
  if (!c) return
  // Keep a draft per conversation.
  if (el.lastConv && el.lastConv !== state.conv) drafts[el.lastConv] = el.input.value
  el.lastConv = state.conv
  el.input.value = drafts[state.conv] ?? ''
  el.input.placeholder = placeholder()
  el.input.setAttribute('aria-label', `消息输入框，${placeholder()}`)
  replyTo = null
  editing = null
  chips = []
  renderContext()
  renderChips()
  const isAgent = c.kind === 'agent'
  const isDm = c.kind === 'dm'
  el.spark.hidden = isAgent
  el.spark.disabled = isDm || !c.agent
  el.spark.setAttribute('data-tip', isDm ? '私信里不能 @助手，请用助手会话' : '@助手')
  el.spark.setAttribute('aria-label', isDm ? '@助手（私信里不可用）' : '@助手')
  autosize()
  updateSend()
}

export function focusComposer() {
  el.input?.focus()
}

export function initComposer() {
  const input = h('textarea.composer__input', {
    rows: '1',
    id: 'composer-input',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-haspopup': 'listbox',
    'aria-keyshortcuts': 'Enter',
    oninput: () => {
      autosize()
      updateSend()
      checkMention()
    },
    onkeydown: onKeyDown,
    onclick: checkMention,
    oncompositionstart: () => {
      composing = true
    },
    oncompositionend: () => {
      composing = false
      lastCompositionEnd = performance.now()
    },
    onpaste: (event) => {
      const files = [...(event.clipboardData?.files ?? [])]
      if (files.length > 0) {
        event.preventDefault()
        addChip(files[0].type.startsWith('image/') ? 'image' : 'file')
      }
    },
    onblur: () => setTimeout(() => !mentionPop?.matches(':hover') && closeMentions(), 120),
  })
  const attach = iconButton({
    icon: 'plus',
    label: '添加附件',
    tip: '添加附件',
    'aria-haspopup': 'menu',
    onClick: (event) =>
      openMenu({
        anchor: event.currentTarget,
        placement: 'top-start',
        focusFirst: event.detail === 0,
        ariaLabel: '添加附件',
        items: [
          {
            label: '照片或视频',
            icon: 'image',
            hint: '最多 20 MiB',
            onSelect: () => addChip('image'),
          },
          {
            label: '文件',
            icon: 'paperclip',
            hint: '最多 100 MiB',
            onSelect: () => addChip('file'),
          },
          { type: 'label', label: '也可以把文件拖进来，或直接粘贴' },
        ],
      }),
  })
  const emoji = iconButton({
    icon: 'smile',
    label: '表情',
    tip: '表情',
    'aria-haspopup': 'dialog',
    onClick: (event) => showEmoji(event.currentTarget),
  })
  const spark = iconButton({
    icon: 'spark',
    label: '@助手',
    tip: '@助手',
    cls: 'composer__spark',
    onClick: () => {
      const ta = input
      const prefix = ta.value && !/\s$/.test(ta.value) ? ' ' : ''
      ta.value += `${prefix}@助手 `
      mentionMap['@助手'] = 'bot'
      ta.focus()
      autosize()
      updateSend()
    },
  })
  const sendBtn = iconButton({
    icon: 'arrow-up',
    label: '发送',
    cls: 'icon-btn--round icon-btn--filled composer__send',
    size: 20,
    onClick: send,
  })
  sendBtn.disabled = true
  const ctx = h('div.composer__ctx', { hidden: true })
  const chipsEl = h('div.composer__chips', { hidden: true })
  const count = h('div.composer__hint', { hidden: true, 'aria-live': 'polite' })
  const capsule = h(
    'div.composer.glass-text',
    ctx,
    chipsEl,
    h('div.composer__row', attach, emoji, spark, input, sendBtn),
    count,
  )
  ui.composerSlotEl.replaceChildren(capsule)
  el = { capsule, input, send: sendBtn, spark, ctx, chips: chipsEl, count, lastConv: null }

  const sync = () => {
    ui.windowEl.style.setProperty('--composer-h', `${capsule.offsetHeight + 16}px`)
    ui.windowEl.style.setProperty('--win-h', `${ui.windowEl.clientHeight}px`)
  }
  new ResizeObserver(sync).observe(capsule)
  new ResizeObserver(() => {
    sync()
    autosize()
  }).observe(ui.windowEl)

  bus.on('conv', renderComposer)
  bus.on('composer:reply', (m) => {
    editing = null
    replyTo = m
    renderContext()
    input.focus()
  })
  bus.on('composer:edit', startEdit)
  bus.on('composer:insert', (text) => {
    input.value = text
    autosize()
    updateSend()
    input.focus()
  })
  bus.on('composer:focus', focusComposer)
  bus.on('composer:send-text', (text) => {
    input.value = text
    autosize()
    updateSend()
    send()
  })
  bus.on('agent:state', updateSend)
  bus.on('agent:run', updateSend)
  renderComposer()
}

export { keycap }
