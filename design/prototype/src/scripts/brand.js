// App icon drafts (docs/11 D: "应用图标：给出草案，M6 的 PWA 要用"). Original shapes only: no Apple marks,
// no SF Symbols (docs/02 section 1). Three directions on a 128 x 128 canvas with a 28px corner radius.

import { s } from './dom.js'

const STAR =
  'M0 -1c.07 .56 .44 .93 1 1-.56 .07-.93 .44-1 1-.07-.56-.44-.93-1-1 .56-.07 .93-.44 1-1Z'

let counter = 0

function defs(children) {
  return s('defs', null, ...children)
}

function gradient(id, stops, { x1 = 0, y1 = 0, x2 = 1, y2 = 1 } = {}) {
  return s(
    'linearGradient',
    { id, x1, y1, x2, y2 },
    ...stops.map(([offset, color, opacity]) =>
      s('stop', { offset, 'stop-color': color, 'stop-opacity': opacity ?? 1 }),
    ),
  )
}

/** Direction A: a white chat bubble with a spark, on a deep blue squircle. */
function iconA(id) {
  return [
    defs([
      gradient(`${id}-bg`, [
        [0, '#6DB4FF'],
        [1, '#3C44D4'],
      ]),
      s(
        'radialGradient',
        { id: `${id}-hl`, cx: 0.25, cy: 0.1, r: 0.9 },
        s('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0.55 }),
        s('stop', { offset: 0.6, 'stop-color': '#fff', 'stop-opacity': 0 }),
      ),
      gradient(`${id}-sp`, [
        [0, '#5FA4FF'],
        [1, '#6A4DE0'],
      ]),
    ]),
    s('rect', { width: 128, height: 128, rx: 30, fill: `url(#${id}-bg)` }),
    s('rect', { width: 128, height: 128, rx: 30, fill: `url(#${id}-hl)` }),
    s('path', {
      d: 'M44 30h40a24 24 0 0 1 24 24v12a24 24 0 0 1-24 24H70L50 108V90H44a24 24 0 0 1-24-24V54a24 24 0 0 1 24-24Z',
      fill: '#fff',
      'fill-opacity': 0.97,
    }),
    s('path', { d: STAR, transform: 'translate(64 60) scale(20)', fill: `url(#${id}-sp)` }),
    s('path', {
      d: STAR,
      transform: 'translate(85 42) scale(7)',
      fill: `url(#${id}-sp)`,
      'fill-opacity': 0.75,
    }),
  ]
}

/** Direction B: two overlapping glass bubbles on a night-blue squircle. */
function iconB(id) {
  return [
    defs([
      gradient(`${id}-bg`, [
        [0, '#23264F'],
        [1, '#0E1030'],
      ]),
      gradient(`${id}-p`, [
        [0, '#FF9ACB'],
        [1, '#7C4DFF'],
      ]),
      gradient(`${id}-t`, [
        [0, '#7BE2C8'],
        [1, '#2D7BEA'],
      ]),
      gradient(`${id}-rim`, [
        [0, '#fff', 0.9],
        [0.5, '#fff', 0.1],
        [1, '#fff', 0.6],
      ]),
    ]),
    s('rect', { width: 128, height: 128, rx: 30, fill: `url(#${id}-bg)` }),
    s('path', {
      d: 'M30 40a18 18 0 0 1 18-18h26a18 18 0 0 1 18 18v14a18 18 0 0 1-18 18H58L40 88V72a18 18 0 0 1-10-16Z',
      fill: `url(#${id}-p)`,
      'fill-opacity': 0.95,
    }),
    s('path', {
      d: 'M56 62a18 18 0 0 1 18-18h26a18 18 0 0 1 18 18v14a18 18 0 0 1-10 16v16L90 94H74a18 18 0 0 1-18-18Z',
      fill: `url(#${id}-t)`,
      'fill-opacity': 0.88,
    }),
    s('path', {
      d: 'M56 62a18 18 0 0 1 18-18h26a18 18 0 0 1 18 18v14a18 18 0 0 1-10 16v16L90 94H74a18 18 0 0 1-18-18Z',
      fill: 'none',
      stroke: `url(#${id}-rim)`,
      'stroke-width': 1.6,
    }),
    s('path', { d: STAR, transform: 'translate(87 69) scale(13)', fill: '#fff' }),
  ]
}

/** Direction C: a ring that is also a speech bubble, with a spark, on a light squircle. */
function iconC(id) {
  return [
    defs([
      gradient(`${id}-bg`, [
        [0, '#FFFFFF'],
        [1, '#E3E6F6'],
      ]),
      gradient(`${id}-ring`, [
        [0, '#4C9BFF'],
        [0.55, '#6A5CF0'],
        [1, '#C55BE0'],
      ]),
    ]),
    s('rect', { width: 128, height: 128, rx: 30, fill: `url(#${id}-bg)` }),
    s('path', {
      d: 'M64 24c-22.1 0-40 16.1-40 36s17.9 36 40 36c4.4 0 8.6-.6 12.5-1.8L98 104V82.3C104.4 76 108 68.4 108 60c0-19.9-17.9-36-44-36Z',
      fill: 'none',
      stroke: `url(#${id}-ring)`,
      'stroke-width': 11,
      'stroke-linejoin': 'round',
    }),
    s('path', { d: STAR, transform: 'translate(64 60) scale(17)', fill: `url(#${id}-ring)` }),
  ]
}

// D4 (2026-10-02, docs/12 D-113) picked A: it is the only one that stays recognizable at 16-32 px and on both
// light and dark backgrounds. B and C stay for comparison.
export const ICON_VARIANTS = {
  a: { name: 'A · 气泡与星', build: iconA, chosen: true },
  b: { name: 'B · 叠层玻璃', build: iconB },
  c: { name: 'C · 环形气泡', build: iconC },
}

/** Returns an <svg> of the chosen draft at `size` px. Ids are made unique so several can share a page. */
export function appIcon(variant = 'a', size = 64, label = 'ChatApp') {
  const id = `ic${++counter}`
  const svg = s(
    'svg',
    { viewBox: '0 0 128 128', width: size, height: size, role: 'img', 'aria-label': label },
    ...ICON_VARIANTS[variant].build(id),
  )
  svg.style.display = 'block'
  svg.style.flex = 'none'
  return svg
}
