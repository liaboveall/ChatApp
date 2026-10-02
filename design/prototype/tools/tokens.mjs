/**
 * Design tokens for ChatApp v2 (docs/02-design-system.md section 4), D2 candidate.
 *
 * This file is the single source of truth: `tokens-css.mjs` turns it into the CSS custom
 * properties the prototype uses, `contrast.mjs` checks it against WCAG 2.2, and the prototype's
 * "Design notes" pages read it directly. Pairs are always `[light, dark]`.
 *
 * Values that the spec table fixes (surfaces, labels, bubble solids) are copied from it. Values the
 * spec leaves open were chosen with the contrast script and are marked "D2".
 */

/** @type {Record<string, [string, string]>} */
export const neutral = {
  'bg-app': ['#F2F2F7', '#000000'],
  'bg-content': ['#FFFFFF', '#1C1C1E'],
  'bg-elevated': ['#FFFFFF', '#2C2C2E'],
  'bubble-in': ['#E9E9EB', '#3A3A3C'],
  label: ['rgb(0 0 0 / 0.88)', 'rgb(255 255 255 / 0.92)'],
  'label-secondary': ['#575762', '#B6B6C2'],
  'label-tertiary': ['#62626C', '#A9A9B5'],
  'label-disabled': ['rgb(60 60 67 / 0.30)', 'rgb(235 235 245 / 0.30)'],
  separator: ['rgb(60 60 67 / 0.18)', 'rgb(84 84 88 / 0.60)'],
  fill: ['rgb(120 120 128 / 0.12)', 'rgb(120 120 128 / 0.24)'],
  'fill-hover': ['rgb(120 120 128 / 0.18)', 'rgb(120 120 128 / 0.32)'],
  'fill-pressed': ['rgb(120 120 128 / 0.26)', 'rgb(120 120 128 / 0.42)'],
  // D2: 1px outlines of inputs, checkboxes and switch tracks. At least 3:1 on every surface and on `fill`.
  'control-border': ['#828288', '#8C8C92'],
  // D2: tooltip and toast, switch/segmented thumb, modal scrim.
  'toast-bg': ['#2C2C2E', '#E5E5EA'],
  'toast-fg': ['#FFFFFF', '#1C1C1E'],
  'seg-thumb': ['#FFFFFF', '#636366'],
  scrim: ['rgb(0 0 0 / 0.30)', 'rgb(0 0 0 / 0.50)'],
}

/**
 * Code blocks (spec 5: Shiki with CSS-variable themes, one light and one dark). Every colour has to
 * reach 4.5:1 on `bg`. Inside bubbles the block keeps its own background.
 */
export const code = {
  bg: ['#F4F4F8', '#141416'],
  fg: ['#24242B', '#E6E6EE'],
  keyword: ['#8A1FA3', '#D8A4FF'],
  string: ['#0A6B3A', '#7BE3A0'],
  comment: ['#686873', '#9A9AA8'],
  function: ['#0B5CAD', '#80B9FF'],
  number: ['#A64400', '#FFB27A'],
  type: ['#0F6B77', '#6FD7E6'],
}

/**
 * Accent colours. `deco` is the vivid colour for gradients, glows and tints, never for text.
 * `solid` + `on` is the readable pair for bubbles, filled buttons and badges (spec table, 4.1).
 * `text` is D2: accent-coloured text, links, icons and focus rings. It stays at least 4.7:1 on
 * every surface, including surfaces with a 16% tint of the accent on top.
 */
export const accents = {
  blue: {
    name: '蓝',
    deco: ['#007AFF', '#0A84FF'],
    solid: ['#0066CC', '#0A84FF'],
    text: ['#0056AE', '#8BBDFE'],
  },
  purple: {
    name: '紫',
    deco: ['#9B4FD8', '#B278F0'],
    solid: ['#7030A0', '#BF8AFF'],
    text: ['#7030A0', '#D4B6FE'],
  },
  pink: {
    name: '粉',
    deco: ['#E83E8C', '#FF6FB0'],
    solid: ['#B0246B', '#FF7ABB'],
    text: ['#A41461', '#FFAACF'],
  },
  red: {
    name: '红',
    deco: ['#F0443A', '#FF6259'],
    solid: ['#B42318', '#FF7369'],
    text: ['#AB170D', '#FFABA1'],
  },
  orange: {
    name: '橙',
    deco: ['#F59A23', '#FFA64D'],
    solid: ['#9C4800', '#FFA352'],
    text: ['#8E4203', '#FEBA82'],
  },
  yellow: {
    name: '黄',
    deco: ['#F2C500', '#FFD740'],
    solid: ['#725700', '#FFD65A'],
    text: ['#6E5404', '#FFD65A'],
  },
  green: {
    name: '绿',
    deco: ['#2FBF5B', '#4CD97B'],
    solid: ['#19703D', '#59D889'],
    text: ['#066634', '#63E192'],
  },
  graphite: {
    name: '石墨',
    deco: ['#8A8A94', '#9A9AA4'],
    solid: ['#50505A', '#A8A8B3'],
    text: ['#50505A', '#C4C4D0'],
  },
}
export const ACCENT_ON = ['#FFFFFF', '#000000']
export const DEFAULT_ACCENT = 'blue'

/**
 * Status colours. `deco` marks dots and backgrounds (spec 4.1 values). `text` is for text and
 * icons on surfaces, `solid` + white/black for filled buttons (D2: the spec has no readable variants).
 */
export const status = {
  danger: {
    name: '危险',
    deco: ['#FF3B30', '#FF453A'],
    text: ['#CF0317', '#FE8D82'],
    solid: ['#E02326', '#FF7369'],
  },
  warning: {
    name: '警告',
    deco: ['#FF9500', '#FF9F0A'],
    text: ['#975603', '#FB9416'],
    solid: ['#AB6100', '#FFA352'],
  },
  success: {
    name: '成功',
    deco: ['#34C759', '#30D158'],
    text: ['#017634', '#1CC760'],
    solid: ['#02853C', '#59D889'],
  },
  info: {
    name: '提示',
    deco: ['#007AFF', '#0A84FF'],
    text: ['#0365C4', '#71AFFF'],
    solid: ['#0172DC', '#0A84FF'],
  },
}

/**
 * Glass materials (spec section 2). `alpha` is the share of the glass fill colour, `blur` in px.
 * `floor` (D2) is the lowest alpha for glass that carries text over arbitrary content (toolbar,
 * composer, menus, sheets): `contrast.mjs` derives it from the worst backdrops, black and white.
 */
export const glass = {
  base: ['#FFFFFF', '#1E1E22'],
  floor: [0.9, 0.88],
  levels: {
    clear: { name: '清透', alpha: 0.45, blur: 20, saturate: 1.7, tint: 0 },
    standard: { name: '标准', alpha: 0.62, blur: 24, saturate: 1.8, tint: 0 },
    tinted: { name: '着色', alpha: 0.8, blur: 28, saturate: 1.8, tint: 0.14 },
    opaque: { name: '不透明', alpha: 1, blur: 0, saturate: 1, tint: 0 },
  },
  maxBackdropFilters: 4,
}
export const DEFAULT_GLASS = 'standard'

/** Tint of the open conversation's row in the sidebar (D2). The check covers label and secondary text on it. */
export const SELECTED_TINT = 0.08

/**
 * Wallpaper under the sidebar (D2). The sidebar glass is checked against these stops, and against
 * the accent blob at `maxTint`: no wallpaper layer may be more opaque than that (see 30-shell.css).
 */
export const wallpaper = {
  maxTint: [0.3, 0.34],
  light: ['#F2F2F7', '#DCE6FF', '#F3DDF0', '#DDF2E8'],
  dark: ['#000000', '#0B1A3A', '#2A1238', '#0A2A24'],
}

export const radius = {
  window: 16,
  card: 14,
  control: 10,
  bubble: 18,
  'bubble-join': 6,
  pill: 999,
}

/** Spacing steps, px (4px grid). */
export const space = [4, 8, 12, 16, 20, 24, 32, 40]

/** Type scale (spec 4.3): `[font-size px, line-height px, weight]`. */
export const type = {
  'large-title': [26, 32, 700],
  'title-1': [22, 28, 700],
  'title-2': [17, 22, 600],
  'title-3': [15, 20, 600],
  headline: [13, 18, 600],
  body: [14, 20, 400],
  message: [15, 22, 400],
  callout: [13, 18, 400],
  subheadline: [12, 16, 400],
  footnote: [11, 14, 400],
}

export const fontStacks = {
  system:
    'system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Noto Sans SC", sans-serif',
  // Inter only covers Latin. Apple platforms still hit the system font first; CJK always falls through to system fonts.
  inter:
    '-apple-system, BlinkMacSystemFont, "Inter", "PingFang SC", "Microsoft YaHei UI", "Noto Sans SC", sans-serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
}

/** Spring presets (spec 4.5): unit mass, stiffness and damping. */
export const springs = {
  snappy: { stiffness: 500, damping: 38 },
  smooth: { stiffness: 300, damping: 30 },
  bouncy: { stiffness: 400, damping: 22 },
}

/**
 * Turns a spring into a CSS `linear()` easing. The curve is the exact unit-mass solution of
 * x'' = -k x - c x', sampled until it settles within 0.1%.
 * @returns {{ duration: number, easing: string }} duration in ms
 */
export function springEasing({ stiffness, damping }, samples = 36) {
  const wn = Math.sqrt(stiffness)
  const zeta = damping / (2 * wn)
  const progress = (t) => {
    if (zeta < 1) {
      const wd = wn * Math.sqrt(1 - zeta * zeta)
      return (
        1 - Math.exp(-zeta * wn * t) * (Math.cos(wd * t) + ((zeta * wn) / wd) * Math.sin(wd * t))
      )
    }
    return 1 - Math.exp(-wn * t) * (1 + wn * t)
  }
  let duration = 0
  for (let t = 0; t < 3; t += 0.001) {
    if (Math.abs(1 - progress(t)) > 0.001) duration = t
  }
  duration += 0.001
  const points = []
  for (let i = 0; i <= samples; i++) {
    const value = i === samples ? 1 : progress((duration * i) / samples)
    points.push(Number(value.toFixed(3)))
  }
  points[0] = 0
  return { duration: Math.round(duration * 1000), easing: `linear(${points.join(', ')})` }
}
