// Authentication pages (docs/01 section 4.1, docs/11 M1b): login, register with invite code, verify
// email, confirm from the mail link, forgot and reset password. All forms validate in the page and
// explain what is wrong; none of them talks to a server.

import { appIcon } from './brand.js'
import { bus, state, ui } from './core.js'
import { h, icon, sleep } from './dom.js'
import { toast } from './overlays.js'
import { banner, button } from './widgets.js'

const PRODUCT = 'ChatApp' // the real product name is a config item (D-019)
const WEAK = ['password123', '1234567890', 'qwertyuiop', 'iloveyou123', 'chatapp123']
const RESERVED_USERNAMES = ['admin', 'system', 'root', 'support', 'assistant', 'agent']
const RESERVED_NAMES = ['助手', '系统', '管理员']

const go = (view) => bus.emit('view:set', view)
const mask = (email) => email.replace(/^(.).*(@.*)$/, '$1***$2')

function field({
  id,
  label,
  type = 'text',
  hint,
  autocomplete,
  value = '',
  required = true,
  inputmode,
  trailing,
}) {
  const input = h('input.input.input--lg', {
    id,
    type,
    autocomplete,
    value,
    required,
    inputmode,
    'aria-describedby': `${id}-msg`,
  })
  const msg = h(
    'div',
    { id: `${id}-msg`, 'aria-live': 'polite' },
    hint ? h('div.field__hint', hint) : null,
  )
  const wrap = h(
    'div.field',
    h('label.field__label', { for: id }, label),
    trailing ? h('div.input-wrap', input, trailing) : input,
    msg,
  )
  wrap.input = input
  wrap.error = (text) => {
    input.setAttribute('aria-invalid', text ? 'true' : 'false')
    msg.replaceChildren(
      text
        ? h('div.field__error', icon('circle-alert', 16), text)
        : hint
          ? h('div.field__hint', hint)
          : '',
    )
  }
  wrap.ok = (text) => {
    input.setAttribute('aria-invalid', 'false')
    msg.replaceChildren(h('div.field__ok', icon('circle-check', 16), text))
  }
  return wrap
}

function passwordField(id, label, autocomplete) {
  const eye = h('button.icon-btn', {
    type: 'button',
    'aria-label': '显示密码',
    'aria-pressed': 'false',
    'data-tip': '显示或隐藏密码',
  })
  const f = field({ id, label, type: 'password', autocomplete, trailing: eye })
  eye.appendChild(icon('eye', 18))
  eye.addEventListener('click', () => {
    const show = f.input.type === 'password'
    f.input.type = show ? 'text' : 'password'
    eye.setAttribute('aria-pressed', String(show))
    eye.setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
    eye.replaceChildren(icon(show ? 'eye-off' : 'eye', 18))
  })
  return f
}

function policy(pw, emailInput) {
  const items = [
    ['len', '至少 10 位', (v) => v.length >= 10],
    ['weak', '不是常见弱密码', (v) => v.length > 0 && !WEAK.includes(v.toLowerCase())],
    [
      'mine',
      '不含邮箱前缀或产品名',
      (v) =>
        v.length > 0 &&
        !v.toLowerCase().includes(PRODUCT.toLowerCase()) &&
        !(
          emailInput?.value &&
          v.toLowerCase().includes(emailInput.value.split('@')[0].toLowerCase()) &&
          emailInput.value.split('@')[0].length > 2
        ),
    ],
  ]
  const list = h('ul', {
    'aria-label': '密码要求',
    style: { display: 'grid', gap: '4px', marginTop: '2px' },
  })
  const draw = () => {
    list.replaceChildren(
      ...items.map(([, text, test]) => {
        const v = pw.value
        const ok = test(v)
        const touched = v.length > 0
        return h(
          'li.field__hint',
          {
            style: {
              display: 'flex',
              gap: '6px',
              alignItems: 'center',
              color: touched
                ? ok
                  ? 'var(--success-text)'
                  : 'var(--danger-text)'
                : 'var(--label-secondary)',
            },
          },
          icon(!touched ? 'circle' : ok ? 'circle-check' : 'circle-x', 16),
          text,
          h('span.sr-only', !touched ? '，还没有输入' : ok ? '，已满足' : '，未满足'),
        )
      }),
    )
  }
  pw.addEventListener('input', draw)
  emailInput?.addEventListener('input', draw)
  draw()
  list.valid = () => items.every(([, , test]) => test(pw.value))
  return list
}

function card(...children) {
  return h('div.auth-card.glass-text.squircle', ...children)
}

function head(title, text, iconName) {
  return h(
    'div.auth-head',
    iconName ? h('div.auth-head__icon', icon(iconName, 28)) : appIcon('a', 56),
    h('h1.t-title-1.t-balance', title),
    text ? h('p.t-body.t-secondary.t-pretty', text) : null,
  )
}

function protoHint(text) {
  return h('p.proto-hint', icon('info', 14), h('span', '原型提示：', text))
}

// ---- Pages ----

function login() {
  const email = field({
    id: 'login-email',
    label: '邮箱',
    type: 'email',
    autocomplete: 'username',
    value: state.auth?.email ?? '',
  })
  const pw = passwordField('login-pw', '密码', 'current-password')
  const slot = h('div')
  const submit = button({ label: '登录', kind: 'filled', size: 'lg', type: 'submit', block: true })
  const form = h(
    'form.auth-form',
    { novalidate: true },
    slot,
    email,
    pw,
    h(
      'div.auth-links',
      h('a', { href: '#', onclick: (e) => (e.preventDefault(), go('forgot')) }, '忘记密码？'),
    ),
    submit,
    h('div.auth-or', h('span', '或')),
    button({
      label: '使用 Passkey 登录',
      icon: 'fingerprint-pattern',
      kind: 'tinted',
      size: 'lg',
      block: true,
      onClick: () => toast('原型：这里会弹出系统的 Passkey 登录窗口，密码和 Passkey 都能登录'),
    }),
  )
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    slot.replaceChildren()
    email.error(email.input.value.includes('@') ? '' : '请输入完整的邮箱地址')
    pw.error(pw.input.value ? '' : '请输入密码')
    if (!email.input.value.includes('@') || !pw.input.value) return
    submit.setAttribute('aria-busy', 'true')
    submit.disabled = true
    await sleep(700)
    submit.removeAttribute('aria-busy')
    submit.disabled = false
    if (email.input.value.includes('unverified')) {
      state.auth = { email: email.input.value }
      slot.replaceChildren(
        banner('warning', 'mail', [
          '这个邮箱还没有验证，不能登录。',
          h(
            'div',
            { style: { marginTop: '8px' } },
            button({
              label: '重新发送验证邮件',
              kind: 'tinted',
              size: 'sm',
              onClick: () => go('verify'),
            }),
          ),
        ]),
      )
      return
    }
    if (pw.input.value === 'wrong') {
      slot.replaceChildren(
        banner('danger', 'circle-alert', '邮箱或密码不对。连续输错会被暂时限制，请稍后再试。'),
      )
      return
    }
    toast('欢迎回来，周屿')
    go('app')
  })
  return card(
    head(`登录 ${PRODUCT}`, '邀请制的实时聊天社区。没有账号？需要有人给你一个邀请码。'),
    form,
    h(
      'p.auth-foot',
      '有邀请码？',
      h('a', { href: '#', onclick: (e) => (e.preventDefault(), go('register')) }, '注册账号'),
    ),
    protoHint(
      '随便填一个邮箱和密码就能进入。邮箱里带 unverified 会看到「未验证」，密码填 wrong 会看到「密码错误」。',
    ),
  )
}

function register(variant = 'ok') {
  const code =
    variant === 'invalid'
      ? 'BAD-CODE-0000'
      : variant === 'expired'
        ? 'EXPIRED-7F3A'
        : 'C4XQ-9T2M-K7RA-2LPD'
  const invite = field({
    id: 'reg-invite',
    label: '邀请码',
    value: code,
    hint: '来自注册链接的 # 后面，不会发到服务器。也可以手动输入。',
  })
  const email = field({ id: 'reg-email', label: '邮箱', type: 'email', autocomplete: 'email' })
  const user = field({
    id: 'reg-user',
    label: '用户名',
    autocomplete: 'username',
    hint: '3–20 位小写字母、数字、下划线，用于 @提及。',
  })
  const name = field({
    id: 'reg-name',
    label: '显示名',
    autocomplete: 'nickname',
    hint: '1–32 个字符，可以重复，支持中文和 emoji。',
  })
  const pw = passwordField('reg-pw', '密码', 'new-password')
  const rules = policy(pw.input, email.input)
  const agree = h(
    'label.check',
    h('input#reg-agree', { type: 'checkbox' }),
    h(
      'span',
      '我已阅读',
      h(
        'a',
        { href: '#', onclick: (e) => (e.preventDefault(), toast('原型：这里会打开隐私说明')) },
        '隐私说明',
      ),
    ),
  )
  const slot = h('div')

  const checkInvite = () => {
    const v = invite.input.value.trim().toUpperCase()
    if (!v || v.startsWith('BAD'))
      return invite.error('邀请码无效。请向邀请你的人确认，或让对方重新生成一个。'), false
    if (v.includes('EXPIRED')) return invite.error('邀请码已过期。请让对方重新生成一个。'), false
    if (v.includes('USED')) return invite.error('邀请码已经用完了。请让对方重新生成一个。'), false
    invite.ok('邀请码有效，还剩 6 天')
    return true
  }
  invite.input.addEventListener('blur', checkInvite)
  user.input.addEventListener('input', () => {
    const v = user.input.value
    if (!v) return user.error('')
    if (!/^[a-z0-9_]{3,20}$/.test(v))
      return user.error('用户名要 3–20 位，只能用小写字母、数字和下划线。')
    if (RESERVED_USERNAMES.includes(v)) return user.error('这个用户名被保留了，换一个。')
    user.ok('可以使用')
  })
  const submit = button({ label: '注册', kind: 'filled', size: 'lg', type: 'submit', block: true })
  const form = h(
    'form.auth-form',
    { novalidate: true },
    slot,
    invite,
    email,
    user,
    name,
    pw,
    rules,
    agree,
    submit,
  )
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    slot.replaceChildren()
    let ok = checkInvite()
    if (!email.input.value.includes('@')) email.error('请输入完整的邮箱地址'), (ok = false)
    else email.error('')
    if (!/^[a-z0-9_]{3,20}$/.test(user.input.value))
      user.error('用户名要 3–20 位，只能用小写字母、数字和下划线。'), (ok = false)
    const n = user.input.value
    if (RESERVED_USERNAMES.includes(n)) user.error('这个用户名被保留了，换一个。'), (ok = false)
    const dn = name.input.value.trim()
    if (!dn || dn.length > 32 || RESERVED_NAMES.includes(dn))
      name.error(
        !dn
          ? '请填写显示名'
          : dn.length > 32
            ? '显示名最多 32 个字符'
            : '这个显示名被保留了，换一个。',
      ),
        (ok = false)
    else name.error('')
    if (!rules.valid()) pw.error('密码还没有满足上面的要求。'), (ok = false)
    else pw.error('')
    if (!agree.querySelector('input').checked)
      slot.replaceChildren(banner('danger', 'circle-alert', '请先勾选「我已阅读隐私说明」。')),
        (ok = false)
    if (!ok) return
    submit.setAttribute('aria-busy', 'true')
    submit.disabled = true
    await sleep(700)
    state.auth = { email: email.input.value }
    go('verify')
  })
  if (variant !== 'ok') queueMicrotask(checkInvite)
  return card(
    head(`注册 ${PRODUCT}`, '需要一个邀请码。注册后要验证邮箱，才能登录。'),
    form,
    h(
      'p.auth-foot',
      '已有账号？',
      h('a', { href: '#', onclick: (e) => (e.preventDefault(), go('login')) }, '登录'),
    ),
    protoHint('填好所有项再点注册。邀请码里带 BAD、EXPIRED 或 USED 会看到对应的错误。'),
  )
}

function verify() {
  const email = state.auth?.email ?? 'mars@example.test'
  const resend = button({ label: '重新发送验证邮件', kind: 'tinted', size: 'lg', block: true })
  let left = 0
  let timer = 0
  const label = () => {
    resend.replaceChildren(left > 0 ? `${left} 秒后可以重发` : '重新发送验证邮件')
    resend.disabled = left > 0
  }
  resend.addEventListener('click', () => {
    left = 60
    label()
    toast('已重新发送。旧的验证链接已失效')
    clearInterval(timer)
    timer = setInterval(() => {
      left -= 1
      label()
      if (left <= 0) clearInterval(timer)
    }, 1000)
  })
  return card(
    head(
      '查看你的邮箱',
      `我们向 ${mask(email)} 发送了验证邮件。链接 1 小时内有效，只能使用一次，验证后才能登录。`,
      'mail-check',
    ),
    h(
      'div.auth-form',
      resend,
      h('p.t-sub.t-secondary', '重发后，旧的链接会失效。7 天内没有验证，账号会被自动删除。'),
      h(
        'p.auth-foot',
        '邮箱填错了？',
        h('a', { href: '#', onclick: (e) => (e.preventDefault(), go('register')) }, '重新注册'),
      ),
    ),
    protoHint('本地开发时邮件在 Mailpit 里（localhost:8025）。'),
    button({
      label: '（原型）模拟点击邮件里的链接',
      kind: 'plain',
      size: 'sm',
      onClick: () => go('verify-confirm'),
    }),
  )
}

function verifyConfirm(variant = 'ready') {
  const slot = h('div.auth-form')
  const draw = (stage) => {
    if (stage === 'done') {
      slot.replaceChildren(
        h(
          'div.auth-head',
          h('div.auth-head__icon.auth-head__icon--ok', icon('circle-check', 28)),
          h('h1.t-title-1', '邮箱已验证'),
          h('p.t-body.t-secondary', '现在可以登录了。'),
        ),
        button({
          label: '去登录',
          kind: 'filled',
          size: 'lg',
          block: true,
          onClick: () => go('login'),
        }),
      )
    } else if (stage === 'expired') {
      slot.replaceChildren(
        h(
          'div.auth-head',
          h('div.auth-head__icon.auth-head__icon--bad', icon('circle-alert', 28)),
          h('h1.t-title-1', '这个链接不能用了'),
          h(
            'p.t-body.t-secondary',
            '它可能已经过期（1 小时有效）、已经用过，或者你又重发过验证邮件。',
          ),
        ),
        button({
          label: '重新发送验证邮件',
          kind: 'filled',
          size: 'lg',
          block: true,
          onClick: () => go('verify'),
        }),
      )
    } else {
      slot.replaceChildren(
        h(
          'div.auth-head',
          h('div.auth-head__icon', icon('shield-check', 28)),
          h('h1.t-title-1', '确认验证邮箱'),
          h(
            'p.t-body.t-secondary.t-pretty',
            `你正在验证 ${mask(state.auth?.email ?? 'mars@example.test')}。点下面的按钮完成验证。这一步需要你亲自确认，邮件扫描器打开链接不会消耗它。`,
          ),
        ),
        button({
          label: '确认验证',
          kind: 'filled',
          size: 'lg',
          block: true,
          onClick: async () => (await sleep(500), draw('done')),
        }),
        h(
          'a.auth-foot',
          { href: '#', onclick: (e) => (e.preventDefault(), draw('expired')) },
          '（原型）看看链接已过期的样子',
        ),
      )
    }
  }
  draw(variant)
  return card(slot)
}

function forgot(sent = false) {
  if (sent) {
    return card(
      head(
        '检查你的邮箱',
        '如果这个邮箱已经注册，你会收到一封重置密码的邮件。链接 1 小时内有效，只能使用一次。',
        'mail-check',
      ),
      h(
        'div.auth-form',
        h(
          'p.t-sub.t-secondary',
          '没收到？先看看垃圾邮件文件夹。出于安全，我们不会告诉你这个邮箱是否注册过。',
        ),
        button({
          label: '回到登录',
          kind: 'tinted',
          size: 'lg',
          block: true,
          onClick: () => go('login'),
        }),
      ),
      button({
        label: '（原型）模拟点击邮件里的链接',
        kind: 'plain',
        size: 'sm',
        onClick: () => go('reset'),
      }),
    )
  }
  const email = field({ id: 'fg-email', label: '邮箱', type: 'email', autocomplete: 'username' })
  const form = h(
    'form.auth-form',
    { novalidate: true },
    email,
    button({ label: '发送重置邮件', kind: 'filled', size: 'lg', type: 'submit', block: true }),
  )
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!email.input.value.includes('@')) return email.error('请输入完整的邮箱地址')
    go('forgot-sent')
  })
  return card(
    head('找回密码', '输入注册时用的邮箱，我们会发一封重置密码的邮件。'),
    form,
    h(
      'p.auth-foot',
      h('a', { href: '#', onclick: (e) => (e.preventDefault(), go('login')) }, '回到登录'),
    ),
  )
}

function reset() {
  const pw = passwordField('rs-pw', '新密码', 'new-password')
  const again = passwordField('rs-pw2', '再输入一次', 'new-password')
  const rules = policy(pw.input, null)
  const form = h(
    'form.auth-form',
    { novalidate: true },
    h('input', {
      type: 'text',
      autocomplete: 'username',
      tabindex: '-1',
      'aria-hidden': 'true',
      style: { position: 'absolute', opacity: '0', width: '0', height: '0', pointerEvents: 'none' },
    }),
    pw,
    rules,
    again,
    h(
      'p.t-sub.t-secondary',
      '重置后，所有设备的登录会被注销，由这些设备发起的未完成任务也会被取消。',
    ),
    button({ label: '重置密码', kind: 'filled', size: 'lg', type: 'submit', block: true }),
  )
  const done = () =>
    card(
      h(
        'div.auth-head',
        h('div.auth-head__icon.auth-head__icon--ok', icon('circle-check', 28)),
        h('h1.t-title-1', '密码已重置'),
        h('p.t-body.t-secondary', '所有设备都已退出登录。请用新密码登录。'),
      ),
      button({
        label: '去登录',
        kind: 'filled',
        size: 'lg',
        block: true,
        onClick: () => go('login'),
      }),
    )
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    let ok = true
    if (!rules.valid()) pw.error('密码还没有满足上面的要求。'), (ok = false)
    else pw.error('')
    if (again.input.value !== pw.input.value) again.error('两次输入的密码不一样。'), (ok = false)
    else again.error('')
    if (ok) host.replaceChildren(done())
  })
  const host = h(
    'div',
    { style: { display: 'contents' } },
    card(head('设置新密码', '至少 10 位，不能是常见弱密码。'), form),
  )
  return host
}

const PAGES = {
  login: () => login(),
  register: () => register('ok'),
  'register-invalid': () => register('invalid'),
  'register-expired': () => register('expired'),
  verify: () => verify(),
  'verify-confirm': () => verifyConfirm('ready'),
  'verify-expired': () => verifyConfirm('expired'),
  forgot: () => forgot(false),
  'forgot-sent': () => forgot(true),
  reset: () => reset(),
}

export const AUTH_VIEWS = Object.keys(PAGES)

export function buildAuthView(name) {
  const page = PAGES[name]()
  const overlay = h('div.overlay')
  const authEl = h(
    'div.auth',
    { dataset: { page: name } },
    h('main.auth__inner#main', { tabindex: '-1' }, page),
  )
  const wallpaper = h(
    'div.wallpaper',
    { 'aria-hidden': 'true' },
    h('div.orb.orb--a', {
      style: { left: '-100px', top: '-140px', width: '520px', height: '520px' },
    }),
    h('div.orb.orb--c', { style: { right: '-120px', left: 'auto', bottom: '-160px' } }),
    h('div.orb.orb--d', { style: { right: '10%', top: '5%', width: '320px', height: '320px' } }),
  )
  const el = h('div', { style: { position: 'absolute', inset: '0' } }, wallpaper, authEl, overlay)
  ui.authEl = authEl
  return {
    el,
    overlay,
    focus: () => authEl.querySelector('input, button.btn--filled')?.focus({ preventScroll: true }),
  }
}
