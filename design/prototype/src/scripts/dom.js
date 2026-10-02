// DOM helpers. Nodes are built with createElement and text nodes only, never with innerHTML, the same
// rule the real front end follows (docs/07 SEC-05).

import { LUCIDE } from './icons.generated.js'

const SVG_NS = 'http://www.w3.org/2000/svg'

// Icons Lucide does not ship in this version. `spark` is the four-point star used for the assistant.
const CUSTOM = {
  spark: [
    [
      'path',
      {
        d: 'M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10Z',
      },
    ],
  ],
  smile: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M8 14s1.5 2 4 2 4-2 4-2' }],
    ['path', { d: 'M9 9h.01' }],
    ['path', { d: 'M15 9h.01' }],
  ],
}

export function icon(name, size = 18, extra = '') {
  const nodes = CUSTOM[name] ?? LUCIDE[name]
  if (!nodes) throw new Error(`unknown icon: ${name}`)
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('viewBox', '0 0 24 24')
  el.setAttribute('aria-hidden', 'true')
  el.setAttribute('focusable', 'false')
  const sizeClass = { 16: ' icon--16', 20: ' icon--20', 24: ' icon--24' }[size] ?? ''
  el.setAttribute('class', `icon${sizeClass}${extra ? ` ${extra}` : ''}`)
  for (const [tag, attrs] of nodes) {
    const child = document.createElementNS(SVG_NS, tag)
    for (const key of Object.keys(attrs)) child.setAttribute(key, attrs[key])
    el.appendChild(child)
  }
  return el
}

const TAG = /^([a-z][a-z0-9-]*)?((?:[.#][\w-]+)*)$/i

function addClass(el, value) {
  if (!value) return
  if (typeof value === 'string') {
    for (const name of value.split(/\s+/)) if (name) el.classList.add(name)
  } else if (Array.isArray(value)) {
    for (const item of value) addClass(el, item)
  } else {
    for (const [name, on] of Object.entries(value)) if (on) el.classList.add(name)
  }
}

function append(el, child) {
  if (child === null || child === undefined || child === false || child === true) return
  if (Array.isArray(child)) {
    for (const item of child) append(el, item)
  } else if (child instanceof Node) {
    el.appendChild(child)
  } else {
    el.appendChild(document.createTextNode(String(child)))
  }
}

/**
 * h('button.btn.btn--filled#id', { onclick, 'aria-label': 'x', dataset: {..} }, ...children)
 * `class` takes a string, array or object. `style` takes a string or an object (custom properties ok).
 */
export function h(tag, props, ...children) {
  const match = TAG.exec(tag)
  if (!match) throw new Error(`bad tag: ${tag}`)
  const el = document.createElement(match[1] || 'div')
  for (const part of match[2].match(/[.#][\w-]+/g) ?? []) {
    if (part[0] === '#') el.id = part.slice(1)
    else el.classList.add(part.slice(1))
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props)
    props = null
  }
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue
    if (key === 'class' || key === 'className') addClass(el, value)
    else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value)
      else
        for (const [name, v] of Object.entries(value)) {
          if (name.startsWith('--')) el.style.setProperty(name, String(v))
          else el.style[name] = v
        }
    } else if (key === 'dataset') Object.assign(el.dataset, value)
    else if (key === 'ref') value(el)
    else if (key.startsWith('on') && typeof value === 'function')
      el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected')
      el[key] = value
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  append(el, children)
  return el
}

/** SVG element builder: s('rect', { width: 10 }, child...). Nodes only, no markup strings. */
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs ?? {}))
    if (value !== null && value !== undefined) el.setAttribute(key, String(value))
  append(el, children)
  return el
}

export const $ = (selector, root = document) => root.querySelector(selector)
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
  return el
}

export function replace(el, ...children) {
  clear(el)
  append(el, children)
  return el
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let counter = 0
export const uid = (prefix = 'id') => `${prefix}-${++counter}`

export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options)
  return () => target.removeEventListener(type, handler, options)
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function tabbables(root) {
  return $$(TABBABLE, root).filter((el) => !el.closest('[hidden]') && el.offsetParent !== null)
}

/** Keeps Tab inside `root` until the returned function is called. Focuses the first control. */
export function trapFocus(root, { initial } = {}) {
  const handler = (event) => {
    if (event.key !== 'Tab') return
    const items = tabbables(root)
    if (items.length === 0) {
      event.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    if (
      event.shiftKey &&
      (document.activeElement === first || !root.contains(document.activeElement))
    ) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  root.addEventListener('keydown', handler)
  const target = initial ?? tabbables(root)[0] ?? root
  if (!target.hasAttribute('tabindex') && target === root) root.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
  return () => root.removeEventListener('keydown', handler)
}

/** Polite screen reader announcements. Several calls in a short time are merged into one. */
let liveTimer = 0
let liveQueue = []
export function announce(text) {
  const region = document.getElementById('live-region')
  if (!region) return
  liveQueue.push(text)
  clearTimeout(liveTimer)
  liveTimer = setTimeout(() => {
    region.textContent = liveQueue.join('，')
    liveQueue = []
  }, 400)
}

const FOCUS_AREAS = [
  '.sidebar',
  '.toolbar',
  '.inspector',
  '.composer',
  '.timeline',
  '.proto__bar',
  '.notes__nav',
]

/**
 * Remembers the focused element and returns a function that puts focus back. If the element has been
 * replaced by a re-render in the meantime (the sidebar redraws when a message arrives), the control with
 * the same label in the same area gets the focus instead.
 */
export function rememberFocus() {
  const el = document.activeElement
  if (!el || el === document.body) return () => {}
  const key = (e) => e.getAttribute?.('aria-label') ?? e.dataset?.id ?? e.id ?? null
  const label = key(el)
  const area = FOCUS_AREAS.find((sel) => el.closest(sel))
  return () => {
    if (document.contains(el)) {
      el.focus({ preventScroll: true })
      return
    }
    if (!label) return
    const scope = area ? document.querySelector(area) : document
    const next = [...(scope?.querySelectorAll('[aria-label], [data-id], [id]') ?? [])].find(
      (e) => key(e) === label,
    )
    next?.focus({ preventScroll: true })
  }
}

export function copyText(text) {
  const done = () => true
  const fallback = () => {
    const area = h('textarea', {
      'aria-hidden': 'true',
      style: { position: 'fixed', opacity: '0' },
      value: text,
    })
    document.body.appendChild(area)
    area.select()
    try {
      document.execCommand('copy')
    } catch {
      /* the copy buttons still show their confirmation; selection is the fallback */
    }
    area.remove()
    return true
  }
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(text).then(done, fallback)
  return Promise.resolve(fallback())
}

export function store(key, value) {
  try {
    if (value === undefined) {
      const raw = localStorage.getItem(key)
      return raw === null ? undefined : JSON.parse(raw)
    }
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage can be blocked or empty; the page works without it */
  }
  return undefined
}
