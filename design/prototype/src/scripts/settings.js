// Settings (docs/01 section 4.10): appearance, notifications, account, invitations, assistant.
// Appearance changes apply live to the whole app behind the sheet.

import { ACCENT_ON, accents } from '../../tools/tokens.mjs'
import {
  bus,
  resetPrefs,
  setPref,
  shortcut,
  state,
  systemReducedMotion,
  systemReducedTransparency,
  ui,
} from './core.js'
import { devices, invites, memories } from './data.js'
import { copyText, h, icon, sleep } from './dom.js'
import { openDialog, openModal, toast } from './overlays.js'
import { session } from './toolbar.js'
import { banner, button, iconButton, seg, spinner, switchEl } from './widgets.js'

const TABS = [
  { id: 'appearance', label: '外观', icon: 'palette' },
  { id: 'notifications', label: '通知', icon: 'bell', note: 'M6' },
  { id: 'account', label: '账号', icon: 'user' },
  { id: 'invites', label: '邀请', icon: 'ticket' },
  { id: 'assistant', label: '助手', icon: 'sparkles' },
]

let handle = null
let current = 'appearance'
let bodyEl = null
let headEl = null
let tabButtons = []

const group = (title, ...children) =>
  h('section.group', title ? h('h3.group__title', title) : null, ...children)
const box = (...children) => h('div.group__box', h('div.rows', ...children))
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches
const isDarkNow = () => {
  const t = document.documentElement.getAttribute('data-theme')
  return t ? t === 'dark' : dark()
}

function row(title, help, control, { id } = {}) {
  return h(
    'div.row',
    h(
      'div.row__main',
      h(id ? 'label.row__title' : 'div.row__title', { for: id ?? null }, title),
      help ? h('div.row__help', help) : null,
    ),
    h('div.row__control', control),
  )
}

// ---- Appearance ----

function previewTile() {
  const el = h(
    'div.preview',
    { 'aria-hidden': 'true' },
    h(
      'div.wallpaper',
      h('div.orb.orb--a', {
        style: { width: '160px', height: '160px', left: '-40px', top: '-50px' },
      }),
      h('div.orb.orb--b', {
        style: { width: '120px', height: '120px', left: '10px', bottom: '-30px' },
      }),
    ),
    h(
      'div.preview__side.glass.squircle',
      h('b', '项目组'),
      h('span.t-secondary', 'Alice：图标草案…'),
    ),
    h(
      'div.preview__main',
      h('span.preview__bubble', '深色的气泡对比度测了'),
      h('span.preview__bubble.preview__bubble--out', '5.7，可以过'),
    ),
  )
  return el
}

function appearance() {
  const p = state.prefs
  const reducedTransparency = systemReducedTransparency()
  const reducedMotion = systemReducedMotion()
  const swatchesEl = h('div.swatches', { role: 'radiogroup', 'aria-label': '强调色' })
  const drawSwatches = () => {
    swatchesEl.replaceChildren(
      ...Object.entries(accents).map(([key, a]) => {
        const i = isDarkNow() ? 1 : 0
        return h(
          'button.swatch',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(state.prefs.accent === key),
            'aria-label': a.name,
            'data-tip': `${a.name}（气泡 ${key}）`,
            style: { '--sw': a.solid[i], '--sw-on': ACCENT_ON[i] },
            onclick: () => {
              setPref('accent', key)
              drawSwatches()
            },
          },
          icon('check', 18),
        )
      }),
    )
  }
  drawSwatches()

  const sizeLabel = h('span.t-callout.tabular', {
    style: { minWidth: '3.5em', textAlign: 'right' },
  })
  const slider = h('input.slider#type-size', {
    type: 'range',
    min: '-1',
    max: '3',
    step: '1',
    value: String(p.typeSize),
    'aria-label': '界面字号',
    'aria-valuetext': p.typeSize === 0 ? '默认' : `${p.typeSize > 0 ? '+' : ''}${p.typeSize} 档`,
    oninput: () => {
      const v = Number(slider.value)
      slider.style.setProperty('--p', `${((v + 1) / 4) * 100}%`)
      sizeLabel.textContent = v === 0 ? '默认' : `${v > 0 ? '+' : ''}${v} 档`
      slider.setAttribute('aria-valuetext', sizeLabel.textContent)
      setPref('typeSize', v)
    },
  })
  slider.style.setProperty('--p', `${((p.typeSize + 1) / 4) * 100}%`)
  sizeLabel.textContent = p.typeSize === 0 ? '默认' : `${p.typeSize > 0 ? '+' : ''}${p.typeSize} 档`

  const glassSeg = seg({
    label: '透明度',
    value: reducedTransparency ? 'opaque' : p.glass,
    items: [
      { value: 'clear', label: '清透' },
      { value: 'standard', label: '标准' },
      { value: 'tinted', label: '着色' },
      { value: 'opaque', label: '不透明' },
    ],
    onChange: (v) => setPref('glass', v),
  })
  if (reducedTransparency) for (const b of glassSeg.querySelectorAll('button')) b.disabled = true

  const sample = h(
    'div.group__box',
    { style: { padding: '12px 14px' } },
    h(
      'div',
      { id: 'font-sample', style: { display: 'grid', gap: '4px' } },
      h('div.t-title-2', '今天先把侧栏和输入栏对一遍'),
      h(
        'div.t-message',
        '周五评审改到 15:00，议程见文档。Migration 0007 is done · 128 members · 10:42',
      ),
      h('div.t-sub.t-secondary', 'Segoe UI Variable / SF Pro / PingFang SC · 0123456789'),
    ),
  )
  return [
    previewTile(),
    group(
      '主题',
      box(
        row(
          '外观模式',
          '跟随系统时，会随系统的浅色和深色自动切换。',
          seg({
            label: '外观模式',
            value: p.theme,
            items: [
              { value: 'light', label: '浅色', icon: 'sun' },
              { value: 'dark', label: '深色', icon: 'moon' },
              { value: 'system', label: '跟随系统', icon: 'monitor' },
            ],
            onChange: (v) => (setPref('theme', v), drawSwatches()),
          }),
        ),
      ),
    ),
    group(
      '强调色',
      h(
        'div.group__box',
        { style: { padding: '14px' } },
        swatchesEl,
        h(
          'p.t-sub.t-secondary',
          { style: { marginTop: '10px' } },
          '气泡、按钮和徽标使用对应的可读配色，每一种都按 4.5:1 校验过。',
        ),
      ),
    ),
    group(
      '透明度',
      box(
        row(
          '玻璃材质',
          reducedTransparency
            ? '系统已开启「减少透明度」，已自动使用不透明。'
            : '只有导航层使用玻璃，消息列表始终是实底。',
          glassSeg,
        ),
      ),
    ),
    group(
      '文字与动效',
      box(
        h(
          'div.row',
          h(
            'div.row__main',
            h('label.row__title', { for: 'type-size' }, '界面字号'),
            h('div.row__help', '整体放大或缩小，范围 −1 到 +3 档。'),
          ),
          h(
            'div.row__control',
            { style: { width: '260px', maxWidth: '50%' } },
            h(
              'div.size-row',
              { style: { width: '100%' } },
              h('span.t-sub', 'A'),
              slider,
              h('span.t-title-3', 'A'),
            ),
          ),
        ),
        h(
          'div.row',
          h('div.row__main', h('div.row__title', ' '), null),
          h('div.row__control', sizeLabel),
        ),
        row(
          '减少动态效果',
          reducedMotion
            ? '系统已开启「减少动态效果」。'
            : '所有动画改成不超过 150 毫秒的淡入淡出。',
          switchEl({
            checked: p.reduceMotion || reducedMotion,
            label: '减少动态效果',
            onChange: (v) => setPref('reduceMotion', v),
          }),
        ),
        row(
          '侧栏显示消息预览',
          '关闭后侧栏更紧凑。',
          switchEl({
            checked: !p.compact,
            label: '侧栏显示消息预览',
            onChange: (v) => setPref('compact', !v),
          }),
        ),
      ),
    ),
    group(
      '字体对比（设计阶段专用）',
      box(
        row(
          '西文字体',
          '系统字体（Windows 上是 Segoe UI Variable）或自托管 Inter。中文始终用系统字体。',
          seg({
            label: '西文字体',
            value: p.font,
            items: [
              { value: 'system', label: '系统字体' },
              { value: 'inter', label: 'Inter' },
            ],
            onChange: (v) => setPref('font', v),
          }),
        ),
      ),
      sample,
    ),
    h(
      'div',
      button({
        label: '恢复默认外观',
        kind: 'tinted',
        onClick: () => (resetPrefs(), renderSection('appearance'), toast('已恢复默认外观')),
      }),
    ),
  ]
}

// ---- Notifications (M6) ----

function notifications() {
  return [
    banner(
      'info',
      'info',
      '浏览器推送属于 M6。站内通知中心和标题栏未读数是基础保障，推送能否送达取决于你的浏览器和网络。',
    ),
    group(
      '推送',
      box(
        row(
          '浏览器推送',
          '私信、@我、回复我的、助手等待审批。',
          switchEl({ checked: true, label: '浏览器推送' }),
        ),
        row(
          '推送里显示内容',
          '默认只显示「你有新消息」。开启后最多显示 80 个字的摘要；已发到推送服务的通知可能无法撤回。',
          switchEl({ checked: false, label: '推送里显示内容' }),
        ),
        row(
          '助手等待我批准时通知我',
          '会话设了免打扰时，仍会在站内通知里保留。',
          switchEl({ checked: true, label: '助手等待批准时通知' }),
        ),
      ),
    ),
    group(
      '各会话的通知级别',
      box(
        ...[
          ['# 项目组', '仅 @我'],
          ['周末徒步', '仅 @我'],
          ['Alice Chen', '全部消息'],
          ['# 闲聊', '免打扰（永久）'],
        ].map(([name, level]) =>
          row(
            name,
            null,
            button({
              label: level,
              kind: 'tinted',
              size: 'sm',
              onClick: () => toast('原型：这里会弹出级别菜单'),
            }),
          ),
        ),
      ),
    ),
  ]
}

// ---- Account ----

function pwDialog() {
  const next = h('input.input#pw-new', {
    type: 'password',
    autocomplete: 'new-password',
    'aria-describedby': 'pw-hint',
  })
  const hint = h(
    'div.field__hint#pw-hint',
    '至少 10 位，不能是常见弱密码，也不能包含邮箱前缀或产品名。',
  )
  openDialog({
    title: '修改密码',
    body: h(
      'div',
      { style: { display: 'grid', gap: '12px' } },
      h(
        'div.field',
        h('label.field__label', { for: 'pw-old' }, '当前密码'),
        h('input.input#pw-old', { type: 'password', autocomplete: 'current-password' }),
      ),
      h('div.field', h('label.field__label', { for: 'pw-new' }, '新密码'), next, hint),
      banner(
        'warning',
        'triangle-alert',
        '修改后，其他设备的登录会话会全部注销，由这些设备发起的未完成任务会被取消。',
      ),
    ),
    actions: [
      { label: '取消', kind: 'plain' },
      { label: '修改密码', kind: 'filled', onClick: () => (toast('已修改，其他设备已注销'), true) },
    ],
  })
}

function revokeDialog(device, all = false) {
  const affected = all
    ? devices.filter((d) => !d.current).reduce((n, d) => n + d.tasks, 0)
    : device.tasks
  openDialog({
    title: all ? '注销其他所有设备？' : `注销「${device.name}」？`,
    body: [
      h('p', all ? '其他设备会被立即断开，需要重新登录。' : '这台设备会被立即断开，需要重新登录。'),
      affected > 0
        ? banner('warning', 'triangle-alert', [
            h('b', `会取消 ${affected} 个由这台设备发起的未完成任务`),
            '：提醒 1 个（交周报，明天 09:00）。取消后不会自动恢复。',
          ])
        : h('p.t-secondary', { style: { marginTop: '8px' } }, '这台设备没有未完成的任务。'),
      h(
        'p.t-sub.t-secondary',
        { style: { marginTop: '8px' } },
        '普通退出登录不会取消已授权的助手任务；只有注销设备、改密、重置密码、封禁等安全操作才会。',
      ),
    ],
    actions: [
      { label: '取消', kind: 'plain', autofocus: true },
      {
        label: all ? '注销其他设备' : '注销这台设备',
        kind: 'filled',
        danger: true,
        onClick: () => toast('已注销，对方会在几秒内被踢回登录页'),
      },
    ],
  })
}

function account() {
  const tzNow = '2026年10月2日 周五 10:44'
  return [
    group(
      '资料',
      box(
        row(
          '显示名',
          '1–32 个字符，可以重复。',
          h('input.input#dn', { value: '周屿', style: { width: '200px' }, 'aria-label': '显示名' }),
        ),
        row(
          '用户名',
          '3–20 位小写字母、数字、下划线。每 30 天可改一次，旧用户名保留 30 天。',
          h('input.input#un', {
            value: 'zhouyu',
            style: { width: '200px' },
            'aria-label': '用户名',
          }),
        ),
        row('邮箱', '登录和找回密码用。', h('span.t-callout', 'zhouyu@example.test')),
        row('头像', '头像上传在 M3 提供，现在使用占位。', h('span.t-sub.t-secondary', '占位头像')),
      ),
    ),
    group(
      '登录方式',
      box(
        row(
          '密码',
          '修改后，其他设备会被注销。',
          button({ label: '修改密码…', kind: 'tinted', size: 'sm', onClick: pwDialog }),
        ),
        row(
          'Passkey',
          'Windows Hello · 10月1日添加',
          h(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            button({
              label: '添加',
              icon: 'fingerprint-pattern',
              kind: 'tinted',
              size: 'sm',
              onClick: () => toast('原型：这里会弹出系统的 Passkey 创建窗口'),
            }),
            button({
              label: '移除',
              kind: 'plain',
              size: 'sm',
              danger: true,
              onClick: () => toast('原型：移除前会再次验证你的身份'),
            }),
          ),
        ),
      ),
    ),
    group(
      '登录设备',
      h(
        'div.group__box',
        { style: { padding: '2px 14px' } },
        devices.map((d) =>
          h(
            'div.device',
            h('span.device__icon', icon(d.name.startsWith('iPhone') ? 'smartphone' : 'laptop', 20)),
            h(
              'div',
              { style: { flex: '1', minWidth: '0' } },
              h(
                'div.t-headline',
                d.name,
                d.current
                  ? h('span.badge.badge--role', { style: { marginLeft: '6px' } }, '此设备')
                  : null,
              ),
              h('div.t-sub.t-secondary', `最近活动 ${d.active} · IP ${d.ip}`),
            ),
            d.current
              ? null
              : button({
                  label: '注销',
                  kind: 'tinted',
                  size: 'sm',
                  danger: true,
                  onClick: () => revokeDialog(d),
                }),
          ),
        ),
      ),
      h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
          },
        },
        h(
          'p.t-sub.t-secondary',
          { style: { flex: '1 1 260px' } },
          'IP 和浏览器标识只有你本人能看到，会话结束后即删除。',
        ),
        button({
          label: '注销其他所有设备…',
          kind: 'tinted',
          size: 'sm',
          danger: true,
          onClick: () => revokeDialog(null, true),
        }),
      ),
    ),
    group(
      '时区',
      box(
        row(
          '聊天与提醒使用的时区',
          '固定后，聊天时间、助手理解「明天上午」和提醒确认卡都用这个时区，其他设备不能自动覆盖。',
          seg({
            label: '时区',
            value: 'fixed',
            items: [
              { value: 'browser', label: '跟随浏览器' },
              { value: 'fixed', label: '固定' },
            ],
            onChange: () => toast('原型：固定时区会在所有设备上保持一致'),
          }),
        ),
        row(
          '当前固定为',
          `现在是 ${tzNow}`,
          button({
            label: 'Asia/Shanghai（UTC+08:00）',
            kind: 'tinted',
            size: 'sm',
            onClick: () => toast('原型：这里会弹出时区选择'),
          }),
        ),
        h(
          'div.row',
          h(
            'div.row__main',
            h(
              'p.t-sub.t-secondary',
              '额度按 Asia/Shanghai 重置，与上面的显示时区无关。夏令时中不存在或重复的时间，设置提醒时会要求你明确选择。',
            ),
          ),
        ),
      ),
    ),
    group(
      '危险操作',
      box(
        row(
          '注销账号',
          'M7 提供。会删除个人资料、登录方式、记忆和私有助手会话；发过的消息保留，显示为「已注销用户」。',
          button({ label: '注销账号…', kind: 'tinted', size: 'sm', danger: true, disabled: true }),
        ),
      ),
    ),
  ]
}

// ---- Invites ----

function createInviteDialog() {
  const code = 'C4XQ-9T2M-K7RA-2LPD'
  const link = `https://chat.example.test/register#invite=${code}`
  openDialog({
    title: '邀请码已生成',
    body: h(
      'div',
      { style: { display: 'grid', gap: '12px' } },
      banner(
        'warning',
        'triangle-alert',
        '这个邀请码的明文只显示这一次，离开后只能撤销、不能再看。',
      ),
      h(
        'div.field',
        h('label.field__label', { for: 'inv-code' }, '注册链接（邀请码在 # 后面，不会发到服务器）'),
        h(
          'div.key-field__row',
          h('input.input#inv-code', {
            value: link,
            readonly: true,
            style: { fontFamily: 'var(--font-mono)', fontSize: '12px' },
          }),
          button({
            label: '复制',
            icon: 'copy',
            kind: 'filled',
            onClick: () => copyText(link).then(() => toast('已复制')),
          }),
        ),
      ),
      h(
        'p.t-sub.t-secondary',
        '默认 7 天有效、只能用 1 次。有人用它注册时占用你的一个名额，对应账号被清理或撤销时名额退回。',
      ),
    ),
    actions: [{ label: '完成', kind: 'filled', autofocus: true }],
  })
}

function invitesTab() {
  const { slots } = invites
  return [
    group(
      '名额',
      h(
        'div.group__box',
        { style: { padding: '14px' } },
        h(
          'div.meter',
          h(
            'div.meter__row',
            h('span', '已占用 ', h('b', `${slots.used} / ${slots.total}`)),
            h('span', `还剩 ${slots.total - slots.used} 个`),
          ),
          h(
            'div.meter__bar',
            {
              role: 'progressbar',
              'aria-label': '邀请名额',
              'aria-valuenow': String(slots.used),
              'aria-valuemin': '0',
              'aria-valuemax': String(slots.total),
            },
            h('i', { style: { '--v': `${(slots.used / slots.total) * 100}%` } }),
          ),
        ),
      ),
    ),
    group(
      '生成邀请码',
      box(
        row(
          '有效期',
          '默认 7 天，可以调整。',
          seg({
            label: '有效期',
            value: '7',
            items: [
              { value: '1', label: '1 天' },
              { value: '7', label: '7 天' },
              { value: '30', label: '30 天' },
            ],
          }),
        ),
        row(
          '可使用次数',
          '默认只能用 1 次。',
          seg({
            label: '次数',
            value: '1',
            items: [
              { value: '1', label: '1 次' },
              { value: '3', label: '3 次' },
            ],
          }),
        ),
        h(
          'div.row',
          h('div.row__main'),
          h(
            'div.row__control',
            button({
              label: '生成邀请码',
              icon: 'ticket',
              kind: 'filled',
              onClick: createInviteDialog,
            }),
          ),
        ),
      ),
    ),
    group(
      '我的邀请码',
      box(
        ...invites.codes.map((c) =>
          row(
            `…${c.tail}`,
            `${c.state}${c.expires ? ` · ${c.expires}` : ''} · ${c.uses}`,
            button({
              label: '撤销',
              kind: 'tinted',
              size: 'sm',
              danger: true,
              onClick: () => toast('已撤销，这个邀请码不能再用了'),
            }),
          ),
        ),
      ),
    ),
    group(
      '还没有验证邮箱的注册',
      box(
        ...invites.pending.map((p) =>
          row(
            `@${p.username}`,
            `${p.note}。你只能看到用户名，看不到对方的邮箱。`,
            button({
              label: '撤销注册',
              kind: 'tinted',
              size: 'sm',
              danger: true,
              onClick: () =>
                openDialog({
                  title: `撤销 @${p.username} 的注册？`,
                  body: '账号会被删除，占用的名额退回给你。对方如果已经收到验证邮件，链接不会再生效。',
                  actions: [
                    { label: '取消', kind: 'plain', autofocus: true },
                    {
                      label: '撤销注册',
                      kind: 'filled',
                      danger: true,
                      onClick: () => toast('已撤销，名额已退回'),
                    },
                  ],
                }),
            }),
          ),
        ),
      ),
    ),
  ]
}

// ---- Assistant ----

let keyState = 'empty'
let keyTail = ''

function keyField(redraw) {
  const input = h('input.input#api-key', {
    type: 'password',
    placeholder: 'sk-…',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': 'key-status',
    'aria-label': 'DeepSeek API key',
  })
  const status = h('div.key-state#key-status', { 'aria-live': 'polite' })
  const save = button({
    label: '验证并保存',
    kind: 'filled',
    onClick: async () => {
      const v = input.value.trim()
      if (!v) return input.focus()
      keyState = 'saving'
      redraw()
      await sleep(1100)
      if (v.length < 8 || /bad|invalid/i.test(v)) keyState = 'invalid'
      else {
        keyState = 'saved'
        keyTail = v.slice(-4)
        session.keySource = 'user'
        bus.emit('toolbar:refresh')
      }
      redraw()
    },
  })
  if (keyState === 'saving') {
    status.append(spinner(), '正在验证 key（只调用免费的模型列表接口）…')
    save.disabled = true
  }
  if (keyState === 'invalid')
    status.append(
      h(
        'span',
        { style: { color: 'var(--danger-text)', display: 'flex', gap: '8px' } },
        icon('circle-alert', 16),
        'key 无效或余额不足，没有保存。检查后重新输入。',
      ),
    )
  if (keyState === 'saved') {
    return h(
      'div.key-field',
      h(
        'div.key-field__row',
        h('input.input', {
          value: `••••••••••••${keyTail}`,
          readonly: true,
          'aria-label': '已保存的 API key，只显示末 4 位',
        }),
        button({
          label: '删除',
          kind: 'tinted',
          danger: true,
          onClick: () => (
            (keyState = 'empty'),
            (session.keySource = 'site'),
            bus.emit('toolbar:refresh'),
            redraw(),
            toast('已删除。之后的请求会使用站点额度')
          ),
        }),
      ),
      h(
        'div.key-state',
        { style: { color: 'var(--success-text)' } },
        icon('circle-check', 16),
        `已保存，末 4 位 ${keyTail}`,
      ),
    )
  }
  const form = h(
    'form.key-field',
    { onsubmit: (e) => (e.preventDefault(), save.click()) },
    h('div.key-field__row', input, save),
    status,
  )
  return form
}

function assistantTab() {
  const wrap = h('div', { style: { display: 'grid', gap: '22px' } })
  const keyHost = h('div')
  const redraw = () => {
    keyHost.replaceChildren(keyField(redraw))
    sourceBox.replaceChildren(sourceRow())
  }
  const sourceRow = () =>
    row(
      '优先使用',
      '有可用的自带 key 时默认用它；你也可以选择先用站点额度。',
      seg({
        label: '优先使用',
        value: session.keySource === 'user' ? 'user' : 'site',
        items: [
          { value: 'user', label: '我的 key' },
          { value: 'site', label: '站点额度' },
        ],
        onChange: (v) => (
          (session.keySource = v),
          bus.emit('toolbar:refresh'),
          bus.emit('assistant:epoch', '来源已切换，新对话不会沿用之前的私有上下文'),
          toast('已新开对话段：旧的私有内容不会自动带入')
        ),
      }),
    )
  const sourceBox = h('div.rows', sourceRow())
  keyHost.append(keyField(redraw))
  wrap.append(
    banner('warning', 'triangle-alert', [
      h('b', '今天的站点额度快用完了。'),
      ' 使用自己的 API key，不占每日额度，全站额度用完时也能照常使用。',
      h(
        'div',
        { style: { marginTop: '8px' } },
        button({
          label: '使用自己的 API key',
          kind: 'tinted',
          size: 'sm',
          onClick: () => document.getElementById('api-key')?.focus(),
        }),
      ),
    ]),
    group(
      '用量',
      h(
        'div.group__box',
        { style: { padding: '14px' } },
        h(
          'div.meter',
          h(
            'div.meter__row',
            h('span', '今日已用 ', h('b', '12%')),
            h('span', '明早 00:00 重置（Asia/Shanghai）'),
          ),
          h(
            'div.meter__bar',
            {
              role: 'progressbar',
              'aria-label': '今日用量',
              'aria-valuenow': '12',
              'aria-valuemin': '0',
              'aria-valuemax': '100',
            },
            h('i', { style: { '--v': '12%' } }),
          ),
        ),
        h(
          'p.t-sub.t-secondary',
          { style: { marginTop: '10px' } },
          '额度只针对站点提供的 key。自带 key 的用量单独统计。',
        ),
      ),
    ),
    group(
      '自带 API key',
      h(
        'div.group__box',
        { style: { padding: '14px', display: 'grid', gap: '12px' } },
        h(
          'p.t-callout',
          '填写你自己的 DeepSeek API key：不占每日额度，全站额度用完时也能照常使用，用量单独统计。',
        ),
        keyHost,
        h(
          'p.t-sub.t-secondary',
          '保存后只显示末 4 位，可以随时删除。',
          h(
            'a.privacy-link',
            { href: '#', onclick: (e) => (e.preventDefault(), toast('原型：这里会打开隐私说明')) },
            ' 查看隐私说明',
          ),
        ),
      ),
    ),
    group('key 来源', h('div.group__box', { style: { padding: '2px 14px' } }, sourceBox)),
    group(
      '默认回答模式',
      box(
        row(
          '模式',
          '快速关闭思考；深度开启思考，步数和时长上限更高。',
          seg({
            label: '默认模式',
            value: session.mode,
            items: [
              { value: 'fast', label: '快速' },
              { value: 'deep', label: '深度' },
            ],
            onChange: (v) => (session.mode = v),
          }),
        ),
      ),
    ),
    group(
      '长期记忆',
      box(
        ...memories.map((m) =>
          h(
            'div.row',
            h('div.row__main', h('div.row__title', m.text), h('div.row__help', m.source)),
            h(
              'div.row__control',
              h(
                'label.check',
                h('input', { type: 'checkbox', checked: m.site }),
                h('span.t-sub', '允许站点助手使用'),
              ),
              button({
                label: '删除',
                kind: 'plain',
                size: 'sm',
                danger: true,
                onClick: () => toast('已删除这条记忆'),
              }),
            ),
          ),
        ),
        h(
          'div.row',
          h('div.row__main', h('label.row__title', { for: 'mem-add' }, '手动添加')),
          h(
            'div.row__control',
            h('input.input#mem-add', {
              placeholder: '例如：我在上海，用 24 小时制',
              style: { width: '260px' },
            }),
            button({
              label: '添加',
              kind: 'tinted',
              size: 'sm',
              onClick: () => toast('已添加。默认只供私有助手使用'),
            }),
          ),
        ),
      ),
    ),
  )
  return [wrap]
}

const RENDERERS = {
  appearance,
  notifications,
  account,
  invites: invitesTab,
  assistant: assistantTab,
}

function renderSection(id) {
  current = id
  const tab = TABS.find((t) => t.id === id)
  for (const b of tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === id))
  headEl.replaceChildren(
    h('h2.t-title-1', { id: 'sheet-title', tabindex: '-1' }, tab.label),
    iconButton({
      icon: 'x',
      label: '关闭设置',
      tip: '关闭',
      keys: 'Esc',
      onClick: () => handle?.close(),
    }),
  )
  bodyEl.replaceChildren(...RENDERERS[id]())
  bodyEl.scrollTop = 0
}

export function openSettings(section = 'appearance') {
  if (handle) {
    renderSection(section)
    return
  }
  tabButtons = TABS.map((t) =>
    h(
      'button.sheet__tab',
      {
        type: 'button',
        role: 'tab',
        'aria-selected': 'false',
        dataset: { tab: t.id },
        onclick: () => renderSection(t.id),
      },
      icon(t.icon, 18),
      t.label,
      t.note ? h('small', t.note) : null,
    ),
  )
  const nav = h(
    'div.sheet__nav',
    { role: 'tablist', 'aria-label': '设置分类', 'aria-orientation': 'vertical' },
    h('h2', '设置'),
    tabButtons,
  )
  nav.addEventListener('keydown', (event) => {
    const i = tabButtons.indexOf(document.activeElement)
    if (i < 0 || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
    event.preventDefault()
    const next =
      tabButtons[
        (i + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + tabButtons.length) %
          tabButtons.length
      ]
    next.focus()
    renderSection(next.dataset.tab)
  })
  headEl = h('div.sheet__head')
  bodyEl = h('div.sheet__body.scroll', { role: 'tabpanel', 'aria-labelledby': 'sheet-title' })
  const sheet = h(
    'div.sheet.glass-text.squircle',
    { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
    nav,
    h('div.sheet__main', headEl, bodyEl),
  )
  const scrim = h('div.scrim')
  const layer = h(
    'div',
    { style: { position: 'absolute', inset: '0', zIndex: '1100', pointerEvents: 'auto' } },
    scrim,
    h('div.sheet-host', sheet),
  )
  renderSection(section)
  handle = openModal({
    layer,
    scrim: layer,
    initialFocus: tabButtons.find((b) => b.dataset.tab === section),
    onClose: () => {
      handle = null
    },
  })
}

function shortcutsDialog() {
  const keys = (list) => list.map((k) => h('kbd', k))
  const rows = [
    [[shortcut('⌘', 'K')], '命令面板：跳转、搜索、命令'],
    [[shortcut('⌘', 'J')], '打开或关闭助手面板'],
    [[shortcut('⌥', '↑'), shortcut('⌥', '↓')], '上一个或下一个会话'],
    [[shortcut('⌥', '⇧', '↑'), shortcut('⌥', '⇧', '↓')], '上一个或下一个未读会话'],
    [['↑'], '输入框为空时，编辑上一条消息'],
    [['Enter', 'Shift Enter'], '发送，换行'],
    [['Esc'], '关闭弹层，取消编辑或回复'],
    [[shortcut('⌘', '/')], '快捷键帮助'],
    [[shortcut('⌘', ',')], '设置（浏览器不拦截时有效，否则在命令面板里输入「设置」）'],
  ]
  openDialog({
    title: '快捷键',
    wide: true,
    body: [
      h(
        'div.keys-list',
        rows.map(([k, label]) => h('div.keys-row', h('span', label), h('span', keys(k)))),
      ),
      h(
        'p.t-sub.t-secondary',
        { style: { marginTop: '10px' } },
        '所有功能都能在命令面板里找到，快捷键只是捷径。不使用浏览器保留的组合键（如 Ctrl N、Ctrl T、Ctrl W）。',
      ),
    ],
    actions: [{ label: '完成', kind: 'filled', autofocus: true }],
  })
}

export function initSettings() {
  bus.on('settings:open', (section) => openSettings(section))
  bus.on('shortcuts:open', shortcutsDialog)
  bus.on('prefs', (e) => {
    // The sheet stays open while the preview and swatches follow the change.
    if (handle && current === 'appearance' && (e.key === 'theme' || e.key === '*'))
      renderSection('appearance')
  })
}

export { ui }
