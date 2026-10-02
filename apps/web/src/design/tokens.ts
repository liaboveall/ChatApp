/**
 * Design tokens for ChatApp v2 (docs/02-design-system.md section 4, confirmed at D4, D-113).
 *
 * This file is the single source of truth (D-111): `tokens-css.ts` turns it into the CSS custom properties and the
 * Tailwind theme, `tools/contrast.ts` checks it against WCAG 2.2, and the settings page reads the accent table. Change
 * a value here, run `bun run design:contrast`, and only then update docs/02. Pairs are always `[light, dark]`.
 *
 * Plain data and pure functions only: this module also runs in the browser.
 */

export type Pair = readonly [light: string, dark: string]

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
  // 1px outlines of inputs, checkboxes and switch tracks. At least 3:1 on every surface and on `fill`.
  'control-border': ['#828288', '#8C8C92'],
  // Tooltip and toast, switch/segmented thumb, modal scrim.
  'toast-bg': ['#2C2C2E', '#E5E5EA'],
  'toast-fg': ['#FFFFFF', '#1C1C1E'],
  'seg-thumb': ['#FFFFFF', '#636366'],
  scrim: ['rgb(0 0 0 / 0.30)', 'rgb(0 0 0 / 0.50)'],
} as const satisfies Record<string, Pair>

/**
 * Code blocks (spec 5: Shiki with CSS-variable themes, one light and one dark). Every colour has to reach 4.5:1 on
 * `bg`. Inside bubbles the block keeps its own background.
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
} as const satisfies Record<string, Pair>

export type AccentEntry = {
  /** Display name in the settings swatches. */
  name: string
  /** The vivid colour for gradients, glows and tints, never for text. */
  deco: Pair
  /** Readable pair for bubbles, filled buttons and badges (with `ACCENT_ON`). */
  solid: Pair
  /** Accent-coloured text, links, icons and focus rings: at least 4.7:1 on every surface. */
  text: Pair
}

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
} as const satisfies Record<string, AccentEntry>

export type AccentKey = keyof typeof accents
export const ACCENT_KEYS = Object.keys(accents) as [AccentKey, ...AccentKey[]]
export const ACCENT_ON: Pair = ['#FFFFFF', '#000000']
export const DEFAULT_ACCENT: AccentKey = 'blue'

export type StatusEntry = {
  name: string
  /** Dots and backgrounds. */
  deco: Pair
  /** Text and icons on surfaces. */
  text: Pair
  /** Filled buttons (with `ACCENT_ON`). */
  solid: Pair
}

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
} as const satisfies Record<string, StatusEntry>

export type GlassLevelKey = 'clear' | 'standard' | 'tinted' | 'opaque'
export type GlassLevel = {
  name: string
  alpha: number
  blur: number
  saturate: number
  tint: number
}

/**
 * Glass materials (spec section 2). `alpha` is the share of the glass fill colour, `blur` in px. `floor` is the lowest
 * alpha for glass that carries text over arbitrary content (toolbar, composer, menus, sheets): `contrast.ts` derives it
 * from the worst backdrops, black and white (D-109).
 */
export const glass = {
  base: ['#FFFFFF', '#1E1E22'] as Pair,
  floor: [0.9, 0.88] as readonly [number, number],
  levels: {
    clear: { name: '清透', alpha: 0.45, blur: 20, saturate: 1.7, tint: 0 },
    standard: { name: '标准', alpha: 0.62, blur: 24, saturate: 1.8, tint: 0 },
    tinted: { name: '着色', alpha: 0.8, blur: 28, saturate: 1.8, tint: 0.14 },
    opaque: { name: '不透明', alpha: 1, blur: 0, saturate: 1, tint: 0 },
  } satisfies Record<GlassLevelKey, GlassLevel>,
  maxBackdropFilters: 4,
}
export const GLASS_KEYS = Object.keys(glass.levels) as [GlassLevelKey, ...GlassLevelKey[]]
export const DEFAULT_GLASS: GlassLevelKey = 'standard'

/** Tint of the open conversation's row in the sidebar. The check covers label and secondary text on it. */
export const SELECTED_TINT = 0.08

/**
 * Wallpaper under the sidebar. The sidebar glass is checked against these stops, and against the accent blob at
 * `maxTint`: no wallpaper layer may be more opaque than that (see shell.css).
 */
export const wallpaper = {
  maxTint: [0.3, 0.34] as readonly [number, number],
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
} as const

/** Spacing steps, px (4px grid). Tailwind's default spacing scale already is this grid. */
export const space = [4, 8, 12, 16, 20, 24, 32, 40] as const

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
} as const satisfies Record<string, readonly [number, number, number]>

/** User-selectable size steps (spec 4.3): about 7% per step on every size. */
export const TYPE_SIZE_STEPS = [-1, 0, 1, 2, 3] as const
export type TypeSizeStep = (typeof TYPE_SIZE_STEPS)[number]
export const typeScale = (step: number): number => Number((1 + step * 0.07).toFixed(2))

export const fontStacks = {
  // D4 (2026-10-02, D-113): Inter only covers Latin. Apple platforms still hit their system font first, Latin falls back
  // to system-ui while Inter loads, and CJK always comes from the system fonts.
  sans: '-apple-system, BlinkMacSystemFont, "Inter", system-ui, "PingFang SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Noto Sans SC", sans-serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace',
} as const

/** Spring presets (spec 4.5): unit mass, stiffness and damping. Motion drives the same numbers. */
export const springs = {
  snappy: { stiffness: 500, damping: 38 },
  smooth: { stiffness: 300, damping: 30 },
  bouncy: { stiffness: 400, damping: 22 },
} as const

export type SpringKey = keyof typeof springs

/**
 * Turns a spring into a CSS `linear()` easing. The curve is the exact unit-mass solution of x'' = -k x - c x', sampled
 * until it settles within 0.1%. `duration` is in ms.
 */
export function springEasing(
  { stiffness, damping }: { stiffness: number; damping: number },
  samples = 36,
): { duration: number; easing: string } {
  const wn = Math.sqrt(stiffness)
  const zeta = damping / (2 * wn)
  const progress = (t: number): number => {
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
  const points: number[] = []
  for (let i = 0; i <= samples; i++) {
    const value = i === samples ? 1 : progress((duration * i) / samples)
    points.push(Number(value.toFixed(3)))
  }
  points[0] = 0
  return { duration: Math.round(duration * 1000), easing: `linear(${points.join(', ')})` }
}
