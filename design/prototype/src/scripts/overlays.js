// Overlay primitives: Menu / ContextMenu / Popover, Dialog and modal stack, Toast, Tooltip.
// Focus rules (docs/02 section 7): a closed layer returns focus to what opened it, modal layers trap Tab
// and make the page behind inert, Escape closes the top layer only.

import { ui } from './core.js'
import { announce, clamp, h, icon, rememberFocus, tabbables, trapFocus, uid } from './dom.js'

const rectOf = (el) => (el instanceof Element ? el.getBoundingClientRect() : el)

/** Places `el` (absolutely positioned inside the overlay layer) next to `anchor`, flipping and clamping to the window. */
export function placeNear(el, anchor, { placement = 'bottom-start', gap = 6, bounds } = {}) {
  const win = (bounds ?? ui.windowEl).getBoundingClientRect()
  const a = rectOf(anchor)
  const width = el.offsetWidth
  const height = el.offsetHeight
  let [side, align = 'start'] = placement.split('-')
  const below = win.bottom - a.bottom
  const above = a.top - win.top
  if (side === 'bottom' && below < height + gap + 8 && above > below) side = 'top'
  else if (side === 'top' && above < height + gap + 8 && below > above) side = 'bottom'
  let top = side === 'bottom' ? a.bottom + gap : a.top - height - gap
  let left =
    align === 'end' ? a.right - width : align === 'center' ? a.left + (a.width - width) / 2 : a.left
  left = clamp(left, win.left + 8, Math.max(win.left + 8, win.right - 8 - width))
  top = clamp(top, win.top + 8, Math.max(win.top + 8, win.bottom - 8 - height))
  el.style.left = `${left - win.left}px`
  el.style.top = `${top - win.top}px`
  el.style.setProperty(
    '--origin',
    `${side === 'bottom' ? 'top' : 'bottom'} ${align === 'end' ? 'right' : 'left'}`,
  )
}

// ---- Menu ----

let activeMenu = null

export function closeMenu() {
  activeMenu?.close()
}

/**
 * items: { label, icon, hint, danger, checked, disabled, onSelect } | { type: 'label', label } | { type: 'separator' }
 * Opens next to `anchor` (element or rect) or at `point` ({ x, y }, for context menus).
 */
export function openMenu({
  anchor,
  point,
  items,
  placement,
  ariaLabel,
  focusFirst = true,
  onClose,
  className = '',
  host,
}) {
  closeMenu()
  const overlay = host?.overlayEl ?? ui.overlayEl
  const restoreFocus = rememberFocus()
  const menu = h('div.menu.glass-text', {
    role: 'menu',
    'aria-label': ariaLabel,
    tabindex: '-1',
    class: className,
  })
  let group = h('div.menu__group', { role: 'group' })
  const entries = []
  const flush = () => {
    if (group.childNodes.length > 0) menu.appendChild(group)
    group = h('div.menu__group', { role: 'group' })
  }
  for (const item of items) {
    if (item.type === 'separator') flush()
    else if (item.type === 'label') group.appendChild(h('div.menu__label', item.label))
    else {
      const role = item.checked === undefined ? 'menuitem' : 'menuitemradio'
      const button = h(
        'button.menu__item',
        {
          type: 'button',
          role,
          tabindex: '-1',
          disabled: item.disabled,
          'aria-checked': item.checked === undefined ? null : String(Boolean(item.checked)),
          class: item.danger ? 'menu__item--danger' : '',
          onclick: () => {
            close()
            item.onSelect?.()
          },
          onmousemove: () => button.focus({ preventScroll: true }),
        },
        item.iconNode ?? (item.icon ? icon(item.icon, 16) : null),
        h('span', item.label),
        item.hint ? h('span.menu__hint', item.hint) : null,
      )
      entries.push(button)
      group.appendChild(button)
    }
  }
  flush()
  overlay.appendChild(menu)
  placeNear(
    menu,
    anchor ?? { left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 },
    {
      placement: placement ?? 'bottom-start',
      bounds: host?.boundsEl,
    },
  )

  const onKey = (event) => {
    const enabled = entries.filter((el) => !el.disabled)
    const index = enabled.indexOf(document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      enabled[(index + 1) % enabled.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      enabled[(index - 1 + enabled.length) % enabled.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      enabled[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      enabled[enabled.length - 1]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'Tab') {
      close(false)
    }
  }
  const onOutside = (event) => {
    if (!menu.contains(event.target)) close(false)
  }
  menu.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onOutside, true)

  function close(restore = true) {
    if (activeMenu?.menu !== menu) return
    activeMenu = null
    document.removeEventListener('pointerdown', onOutside, true)
    menu.remove()
    if (restore) restoreFocus()
    onClose?.()
  }
  activeMenu = { menu, close }
  if (focusFirst) (entries.find((el) => !el.disabled) ?? menu).focus({ preventScroll: true })
  else menu.focus({ preventScroll: true })
  return { close, menu }
}

// ---- Modal stack (dialogs, sheets, command palette) ----

const stack = []

function syncInert() {
  const top = stack[stack.length - 1]
  if (ui.appEl) ui.appEl.inert = stack.length > 0
  if (ui.authEl) ui.authEl.inert = stack.length > 0
  for (const entry of stack) entry.layer.inert = entry !== top
}

/**
 * Shows `layer` (an element appended to the overlay layer) as a modal: traps focus, makes everything
 * behind it inert, closes on Escape and on a click on `scrim`, then returns focus to the opener.
 */
export function openModal({ layer, scrim, initialFocus, onClose, closeOnScrim = true }) {
  closeMenu()
  const restoreFocus = rememberFocus()
  ui.overlayEl.appendChild(layer)
  const entry = { layer, close }
  stack.push(entry)
  syncInert()
  const release = trapFocus(layer, { initial: initialFocus })
  const onKey = (event) => {
    if (event.key === 'Escape' && stack[stack.length - 1] === entry) {
      event.stopPropagation()
      event.preventDefault()
      close()
    }
  }
  layer.addEventListener('keydown', onKey)
  if (scrim && closeOnScrim)
    scrim.addEventListener('pointerdown', (event) => event.target === scrim && close())
  function close() {
    const index = stack.indexOf(entry)
    if (index === -1) return
    stack.splice(index, 1)
    release()
    layer.removeEventListener('keydown', onKey)
    layer.remove()
    syncInert()
    restoreFocus()
    onClose?.()
  }
  return { close }
}

export const modalCount = () => stack.length
export function closeAllModals() {
  for (const entry of [...stack].reverse()) entry.close()
}

export function openDialog({
  title,
  body,
  actions = [],
  wide = false,
  onClose,
  role = 'dialog',
  initialFocus,
}) {
  const titleId = uid('dialog-title')
  let handle
  const buttons = actions.map((action) =>
    h(
      `button.btn.btn--${action.kind ?? 'tinted'}${action.danger ? '.btn--danger' : ''}`,
      {
        type: 'button',
        'data-autofocus': action.autofocus ? '' : null,
        onclick: () => {
          const result = action.onClick?.()
          if (result !== false) handle.close()
        },
      },
      action.label,
    ),
  )
  const dialog = h(
    'div.dialog.glass-text',
    {
      role,
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      style: wide ? { width: 'min(600px, 100%)' } : null,
    },
    h('h2.dialog__title', { id: titleId }, title),
    h('div.dialog__body', body),
    actions.length > 0 ? h('div.dialog__actions', buttons) : null,
  )
  const scrim = h('div.scrim')
  const layer = h(
    'div',
    { style: { position: 'absolute', inset: '0', 'z-index': '1100', 'pointer-events': 'auto' } },
    scrim,
    h('div.dialog-host', dialog),
  )
  handle = openModal({
    layer,
    scrim: layer,
    initialFocus: initialFocus ?? layer.querySelector('[data-autofocus]') ?? undefined,
    onClose,
  })
  return handle
}

// ---- Toast ----

export function toast(message, { action, onAction, duration = 4200 } = {}) {
  let stackEl = ui.overlayEl.querySelector('.toast-stack')
  if (!stackEl) {
    stackEl = h('div.toast-stack', { role: 'status', 'aria-live': 'polite' })
    ui.overlayEl.appendChild(stackEl)
  }
  let timer = 0
  const item = h(
    'div.toast',
    h('span', message),
    action
      ? h(
          'button.btn',
          {
            type: 'button',
            onclick: () => {
              onAction?.()
              dismiss()
            },
          },
          action,
        )
      : null,
  )
  const dismiss = () => {
    clearTimeout(timer)
    item.remove()
  }
  item.addEventListener('pointerenter', () => clearTimeout(timer))
  item.addEventListener('pointerleave', () => {
    timer = setTimeout(dismiss, 1500)
  })
  stackEl.appendChild(item)
  timer = setTimeout(dismiss, duration)
  announce(message)
  return { dismiss }
}

// ---- Tooltip ----

let tipEl = null
let tipTimer = 0

function hideTip() {
  clearTimeout(tipTimer)
  tipEl?.remove()
  tipEl = null
}

function showTip(target) {
  hideTip()
  const text = target.getAttribute('data-tip')
  if (!text) return
  const keys = target.getAttribute('data-tip-keys')
  tipEl = h('div.tooltip', { role: 'tooltip' }, text, keys ? h('kbd', keys) : null)
  ui.overlayEl.appendChild(tipEl)
  placeNear(tipEl, target, {
    placement: target.getAttribute('data-tip-placement') ?? 'bottom-center',
    gap: 8,
  })
}

export function initTooltips(root) {
  root.addEventListener('pointerover', (event) => {
    const target = event.target.closest?.('[data-tip]')
    if (!target || event.pointerType === 'touch') return
    clearTimeout(tipTimer)
    tipTimer = setTimeout(() => showTip(target), 450)
  })
  root.addEventListener('pointerout', (event) => {
    if (event.target.closest?.('[data-tip]')) hideTip()
  })
  root.addEventListener('focusin', (event) => {
    const target = event.target.closest?.('[data-tip]')
    if (target?.matches(':focus-visible')) showTip(target)
  })
  root.addEventListener('focusout', hideTip)
  root.addEventListener('pointerdown', hideTip)
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTip()
  })
}

export { tabbables }
