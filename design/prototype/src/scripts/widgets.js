// Small reusable pieces: avatars, badges, buttons, segmented control, switch, rows.

import { people } from './data.js'
import { h, icon, uid } from './dom.js'

export function initials(name) {
  const latin = name.trim().split(/\s+/)
  if (latin.length >= 2 && /^[A-Za-z]/.test(name)) return (latin[0][0] + latin[1][0]).toUpperCase()
  const chars = [...name.trim()]
  return chars.slice(-2).join('')
}

export const presenceLabel = (status) =>
  ({ online: '在线', away: '离开', offline: '离线' })[status] ?? ''

/** Avatar of a person (or the assistant). `presence` adds the status dot. */
export function avatar(id, { size = 36, presence = false, square = false } = {}) {
  const person = people[id]
  if (person.bot) {
    return h(
      'span.avatar.avatar--bot',
      { style: { '--size': `${size}px` }, 'aria-hidden': 'true' },
      icon('spark', 20, 'icon--fill'),
    )
  }
  return h(
    `span.avatar${square ? '.avatar--square' : ''}`,
    { style: { '--size': `${size}px`, '--h': person.hue }, 'aria-hidden': 'true' },
    initials(person.name),
    presence ? h('span.presence', { dataset: { status: person.status } }) : null,
  )
}

export function convAvatar(c, size = 36) {
  if (c.kind === 'dm') return avatar(c.person, { size, presence: true })
  if (c.kind === 'agent') {
    return h(
      'span.avatar.avatar--bot',
      { style: { '--size': `${size}px` }, 'aria-hidden': 'true' },
      icon('spark', 20, 'icon--fill'),
    )
  }
  const glyph = c.kind === 'channel' ? 'hash' : 'users'
  return h(
    'span.avatar.avatar--channel',
    { style: { '--size': `${size}px` }, 'aria-hidden': 'true' },
    icon(glyph, 18),
  )
}

export const badge = (text, variant = '') =>
  h(`span.badge${variant ? `.badge--${variant}` : ''}`, text)

export const botBadge = () => h('span.badge.badge--bot', icon('spark', 16, 'icon--fill'), '机器人')

/** Buttons. `kind`: filled | tinted | plain | glass. */
export function button({
  label,
  icon: iconName,
  kind = 'tinted',
  size,
  danger,
  onClick,
  type = 'button',
  ...rest
}) {
  const cls = ['btn', `btn--${kind}`, size ? `btn--${size}` : '', danger ? 'btn--danger' : '']
    .filter(Boolean)
    .join('.')
  return h(
    `button.${cls}`,
    { type, onclick: onClick, ...rest },
    iconName ? icon(iconName, 16) : null,
    label,
  )
}

export function iconButton({
  icon: iconName,
  label,
  onClick,
  tip,
  keys,
  pressed,
  expanded,
  cls = '',
  size = 18,
  ...rest
}) {
  return h(
    `button.icon-btn${cls ? `.${cls.split(' ').join('.')}` : ''}`,
    {
      type: 'button',
      'aria-label': label,
      'data-tip': tip ?? label,
      'data-tip-keys': keys ?? null,
      'aria-pressed': pressed === undefined ? null : String(pressed),
      'aria-expanded': expanded === undefined ? null : String(expanded),
      onclick: onClick,
      ...rest,
    },
    icon(iconName, size),
  )
}

/**
 * Segmented control. mode 'radio' (a setting) or 'tab' (switches a panel). Arrow keys move the choice.
 * Returns the element; `el.set(value)` changes it from outside.
 */
export function seg({
  items,
  value,
  onChange,
  label,
  mode = 'radio',
  block = false,
  className = '',
}) {
  const thumb = h('span.seg__thumb', { 'aria-hidden': 'true' })
  const role = mode === 'tab' ? 'tab' : 'radio'
  const selectedAttr = mode === 'tab' ? 'aria-selected' : 'aria-checked'
  let current = value
  const buttons = items.map((item) =>
    h(
      'button.seg__item',
      {
        type: 'button',
        role,
        dataset: { value: item.value },
        onclick: () => choose(item.value, true),
        title: item.title ?? null,
        'aria-label': item.ariaLabel ?? null,
      },
      item.icon ? icon(item.icon, 16) : null,
      item.label,
    ),
  )
  const el = h(
    `div.seg${block ? '.seg--block' : ''}${className ? `.${className}` : ''}`,
    { role: mode === 'tab' ? 'tablist' : 'radiogroup', 'aria-label': label },
    thumb,
    buttons,
  )

  function place() {
    const active = buttons.find((b) => b.dataset.value === String(current))
    if (!active || active.offsetWidth === 0) return
    thumb.style.width = `${active.offsetWidth}px`
    thumb.style.transform = `translateX(${active.offsetLeft}px)`
  }
  function paint() {
    for (const b of buttons) {
      const on = b.dataset.value === String(current)
      b.setAttribute(selectedAttr, String(on))
      b.tabIndex = on ? 0 : -1
    }
    place()
  }
  function choose(next, user) {
    if (String(next) === String(current)) return
    current = items.find((i) => String(i.value) === String(next))?.value ?? next
    paint()
    if (user) onChange?.(current)
  }
  el.addEventListener('keydown', (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    if (!(event.key in keys)) return
    event.preventDefault()
    const index = buttons.findIndex((b) => b.dataset.value === String(current))
    const next = buttons[(index + keys[event.key] + buttons.length) % buttons.length]
    next.focus()
    choose(next.dataset.value, true)
  })
  new ResizeObserver(place).observe(el)
  requestAnimationFrame(paint)
  paint()
  el.set = (next) => {
    current = next
    paint()
  }
  return el
}

export function switchEl({ checked, onChange, label, id = uid('sw') }) {
  const el = h('button.switch', {
    type: 'button',
    role: 'switch',
    id,
    'aria-checked': String(Boolean(checked)),
    'aria-label': label,
    onclick: () => {
      const next = el.getAttribute('aria-checked') !== 'true'
      el.setAttribute('aria-checked', String(next))
      onChange?.(next)
    },
  })
  return el
}

/** Label and help on the left, a control on the right. */
export function row({ title, help, control, labelFor }) {
  const id = uid('row')
  return h(
    'div.row',
    h(
      'div.row__main',
      h(labelFor ? 'label.row__title' : 'div.row__title', { id, for: labelFor ?? null }, title),
      help ? h('div.row__help', help) : null,
    ),
    h('div.row__control', control),
  )
}

export function banner(kind, iconName, content) {
  return h(
    `div.banner.banner--${kind}`,
    { role: kind === 'danger' ? 'alert' : null },
    icon(iconName, 18),
    h('div', content),
  )
}

export function emptyState({ icon: iconName, title, text, action, error = false }) {
  return h(
    `div.empty${error ? '.empty--error' : ''}`,
    h('div.empty__icon', icon(iconName, 28)),
    h('div.empty__title', title),
    text ? h('p.empty__text', text) : null,
    action ?? null,
  )
}

export const spinner = () => icon('loader', 16, 'spin')
