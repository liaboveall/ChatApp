// Notification center (docs/02 section 3, M6): bell in the user card, popover with the list.

import { bus, selectConversation, ui } from './core.js'
import { notifications } from './data.js'
import { h, icon, rememberFocus } from './dom.js'
import { placeNear } from './overlays.js'
import { button, emptyState, iconButton, seg } from './widgets.js'

let pop = null
let filter = 'all'
let opener = null
let restore = null

function close(restoreFocus = true) {
  if (!pop) return
  pop.remove()
  pop = null
  document.removeEventListener('pointerdown', outside, true)
  if (restoreFocus) restore?.()
}

function outside(event) {
  if (pop && !pop.contains(event.target) && !opener?.contains(event.target)) close(false)
}

function draw() {
  const items = notifications.filter(
    (n) =>
      filter === 'all' ||
      (filter === 'mention' && n.kind === 'mention') ||
      (filter === 'approval' && n.kind === 'approval'),
  )
  const unread = notifications.filter((n) => n.unread).length
  const list = h(
    'div.notif__list.scroll',
    items.length === 0
      ? emptyState({
          icon: 'bell',
          title: '没有通知',
          text: '@我、回复、助手等待批准和提醒到点都会出现在这里，保留 90 天。',
        })
      : items.map((n) =>
          h(
            'button.notif__item',
            {
              type: 'button',
              dataset: { kind: n.kind },
              onclick: () => {
                n.unread = false
                close(false)
                bus.emit('sidebar:refresh')
                if (n.to) selectConversation(n.to)
              },
            },
            h('span.notif__icon', icon(n.icon, 18)),
            h(
              'span.notif__body',
              h(
                'span.notif__title',
                n.unread ? h('span.notif__dot', { role: 'img', 'aria-label': '未读' }) : null,
                n.title,
              ),
              h('span.notif__text', { style: { display: 'block' } }, n.body),
            ),
            h('span.notif__time', n.time),
          ),
        ),
  )
  pop.replaceChildren(
    h(
      'div',
      { style: { display: 'contents' } },
      h(
        'div',
        h(
          'div.notif__head',
          h('h2', unread ? `通知 · ${unread} 条未读` : '通知'),
          button({
            label: '全部标为已读',
            kind: 'plain',
            size: 'sm',
            disabled: unread === 0,
            onClick: () => {
              for (const n of notifications) n.unread = false
              bus.emit('sidebar:refresh')
              draw()
            },
          }),
          iconButton({
            icon: 'x',
            label: '关闭通知',
            tip: '关闭',
            size: 16,
            onClick: () => close(),
          }),
        ),
        h(
          'div',
          { style: { padding: '0 12px 6px' } },
          seg({
            label: '筛选通知',
            value: filter,
            block: true,
            items: [
              { value: 'all', label: '全部' },
              { value: 'mention', label: '@我' },
              { value: 'approval', label: '审批' },
            ],
            onChange: (v) => ((filter = v), draw()),
          }),
        ),
      ),
      list,
    ),
  )
}

export function toggleNotifications(anchor) {
  if (pop) return close()
  opener = anchor ?? opener
  restore = rememberFocus()
  pop = h('div.notif.glass-text', { role: 'dialog', 'aria-label': '通知' })
  draw()
  ui.overlayEl.appendChild(pop)
  placeNear(pop, opener, { placement: 'top-start', gap: 8 })
  pop.style.setProperty('--origin', 'bottom left')
  document.addEventListener('pointerdown', outside, true)
  pop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
    }
  })
  pop.querySelector('button, [tabindex]')?.focus({ preventScroll: true })
}

export const closeNotifications = () => close(false)

export function initNotifications() {
  bus.on('notifications:toggle', (anchor) => toggleNotifications(anchor))
}
