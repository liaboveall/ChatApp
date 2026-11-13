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

/**
 * The light theme is a warm one (2026-11-13): the window is the off-white of unbleached paper, not pure white, and every
 * neutral beside it (bubbles, fills, hairlines, the grays of text) leans the same warm way, so nothing reads as a cold
 * gray patch on it. Each value keeps the luminance of the cool gray it replaced, or is darker: the contrast margins are
 * the ones that were checked before.
 */
export const neutral = {
  // The backdrop under the floating glass (the wallpaper's base).
  'bg-app': ['#F3EFE7', '#000000'],
  // The window itself: the conversation lies directly on it, edge to edge, and every glass layer floats above it. In the
  // dark theme it is deeper than the glass, so a floating layer reads as lifted, never as a hole.
  'bg-content': ['#FAF7F1', '#0E0E10'],
  'bg-elevated': ['#FFFDF9', '#1C1C1F'],
  'bubble-in': ['#EEE9DF', '#28282C'],
  label: ['rgb(28 22 12 / 0.9)', 'rgb(255 255 255 / 0.92)'],
  'label-secondary': ['#5B564D', '#B6B6C2'],
  'label-tertiary': ['#66615A', '#A9A9B5'],
  'label-disabled': ['rgb(72 62 46 / 0.30)', 'rgb(235 235 245 / 0.30)'],
  separator: ['rgb(72 62 46 / 0.16)', 'rgb(84 84 88 / 0.60)'],
  fill: ['rgb(128 114 92 / 0.12)', 'rgb(120 120 128 / 0.24)'],
  'fill-hover': ['rgb(128 114 92 / 0.18)', 'rgb(120 120 128 / 0.32)'],
  'fill-pressed': ['rgb(128 114 92 / 0.26)', 'rgb(120 120 128 / 0.42)'],
  // 1px outlines of inputs, checkboxes and switch tracks. At least 3:1 on every surface and on `fill`.
  'control-border': ['#878178', '#8C8C92'],
  // Tooltip and toast (a dark heads-up plate in both themes), switch/segmented thumb, modal scrim.
  'toast-bg': ['#2C2C2E', '#3A3A3E'],
  'toast-fg': ['#FFFFFF', '#FFFFFF'],
  'seg-thumb': ['#FFFDF9', '#5C5C62'],
  scrim: ['rgb(0 0 0 / 0.28)', 'rgb(0 0 0 / 0.56)'],
} as const satisfies Record<string, Pair>

/**
 * Code blocks (spec 5: Shiki with CSS-variable themes, one light and one dark). Every colour has to reach 4.5:1 on
 * `bg`. Inside bubbles the block keeps its own background.
 */
export const code = {
  bg: ['#F5F1E9', '#141416'],
  fg: ['#27241F', '#E6E6EE'],
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
  /** Fill of bubbles, filled buttons and badges: deep enough for `ACCENT_ON` (white) at 4.5:1 in both themes. */
  solid: Pair
  /** Accent-coloured text, links, icons and focus rings: at least 4.7:1 on every surface. */
  text: Pair
}

/**
 * The accents are one family of pigments, not of signal colours (2026-11-13). Every hue is made by the same rule in
 * OKLCH, so they differ in hue and not in loudness: the fill sits near a lightness of 0.5 (deep enough for white
 * text) at a chroma of roughly half of what sRGB can show for that hue, the decorative colour is one step lighter and
 * a quarter more chromatic, the text colour is the fill darkened in the light theme and a pale tint in the dark one.
 * At full chroma a bubble or the open conversation's row was the loudest thing on the screen in both themes, and on
 * the warm off-white it also clashed in temperature. Hues with a narrow gamut (teal, yellow, green) are close to their
 * limit and still quiet; the wide ones (blue, purple, pink, red) are held back to match them.
 */
export const accents = {
  // The default (the maintainer's choice among the nine, 2026-11-13): an ink blue, not a signal blue.
  blue: {
    name: '蓝',
    deco: ['#4C7DD9', '#5E8FED'],
    solid: ['#3C61A7', '#4167AD'],
    text: ['#2C4F94', '#9EBEF8'],
  },
  purple: {
    name: '紫',
    deco: ['#836DCE', '#9580E2'],
    solid: ['#604F98', '#6B5BA5'],
    text: ['#503E86', '#BEB4F1'],
  },
  pink: {
    name: '粉',
    deco: ['#C2567D', '#D7688F'],
    solid: ['#964360', '#A04C69'],
    text: ['#833250', '#EDA7BB'],
  },
  red: {
    name: '红',
    deco: ['#D24E45', '#E76157'],
    solid: ['#9F3A34', '#A9443C'],
    text: ['#8B2823', '#F8A49A'],
  },
  orange: {
    name: '橙',
    deco: ['#BF6427', '#D4763C'],
    solid: ['#944E21', '#9D562B'],
    text: ['#813C0B', '#EAAF8E'],
  },
  yellow: {
    name: '黄',
    deco: ['#A17911', '#B48B2D'],
    solid: ['#775809', '#806118'],
    text: ['#634804', '#D4BA89'],
  },
  green: {
    name: '绿',
    deco: ['#3C9467', '#50A678'],
    solid: ['#266A47', '#307250'],
    text: ['#115837', '#9ACBAE'],
  },
  // The blue-green of mineral pigment on warm silk. A hue nothing else in the interface claims (blue is information,
  // green is success and presence, red danger, orange warning, purple the assistant).
  teal: {
    name: '青',
    deco: ['#19919C', '#36A3AE'],
    solid: ['#106A72', '#1A7078'],
    text: ['#05585F', '#91C9D0'],
  },
  graphite: {
    name: '石墨',
    deco: ['#8A8A94', '#9A9AA4'],
    solid: ['#50505A', '#6C6C78'],
    text: ['#50505A', '#C4C4D0'],
  },
} as const satisfies Record<string, AccentEntry>

export type AccentKey = keyof typeof accents
export const ACCENT_KEYS = Object.keys(accents) as [AccentKey, ...AccentKey[]]
/** What is written on an accent or status fill: white in both themes, so the fills are deep enough to carry it. */
export const ACCENT_ON: Pair = ['#FFFFFF', '#FFFFFF']
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
    solid: ['#E02326', '#D4362F'],
  },
  warning: {
    name: '警告',
    deco: ['#FF9500', '#FF9F0A'],
    text: ['#975603', '#FB9416'],
    solid: ['#AB6100', '#B35900'],
  },
  success: {
    name: '成功',
    deco: ['#34C759', '#30D158'],
    text: ['#017634', '#1CC760'],
    solid: ['#02853C', '#1C8246'],
  },
  // The same ink blue as the default accent.
  info: {
    name: '提示',
    deco: ['#4C7DD9', '#5E8FED'],
    text: ['#2F559D', '#91B5F4'],
    solid: ['#3E66B3', '#4167AD'],
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
  base: ['#FFFDF9', '#232328'] as Pair,
  floor: [0.9, 0.9] as readonly [number, number],
  /**
   * The lowest alpha of clear glass: controls that carry icons only (the toolbar's buttons, the tools beside a message,
   * "jump to latest"). An icon in the label colour needs 3:1, not the 4.5:1 of text, so this glass may let far more of
   * what is behind it through. `contrast.ts` derives it the same way as `floor`, over black and white.
   */
  iconFloor: [0.44, 0.56] as readonly [number, number],
  levels: {
    clear: { name: '清透', alpha: 0.45, blur: 22, saturate: 1.9, tint: 0 },
    standard: { name: '标准', alpha: 0.62, blur: 28, saturate: 1.9, tint: 0 },
    tinted: { name: '着色', alpha: 0.8, blur: 32, saturate: 1.8, tint: 0.14 },
    opaque: { name: '不透明', alpha: 1, blur: 0, saturate: 1, tint: 0 },
  } satisfies Record<GlassLevelKey, GlassLevel>,
  /**
   * Blurred layers that may be on screen at once: the sidebar, the title and the tools of the toolbar, the composer and
   * its attach button, and one popup. The small ones cost little; a modal layer takes the blur off everything behind it.
   */
  maxBackdropFilters: 6,
}
export const GLASS_KEYS = Object.keys(glass.levels) as [GlassLevelKey, ...GlassLevelKey[]]
export const DEFAULT_GLASS: GlassLevelKey = 'standard'

/**
 * Wallpaper under the sidebar. The sidebar glass is checked against these stops, and against the accent blob at
 * `maxTint`: no wallpaper layer may be more opaque than that (see shell.css).
 */
export const wallpaper = {
  // The light theme's lights are gentler: on the warm off-white a strong cool tint reads as a stain, not as light.
  maxTint: [0.24, 0.34] as readonly [number, number],
  // The light theme's lower light is this warm one whatever the accent, so the paper keeps its temperature; the dark
  // theme's is a neighbour of the accent (shell.css).
  warmLight: '#F2A468',
  light: ['#F3EFE7', '#DCE6FF', '#F3DDF0', '#F6E3CF'],
  dark: ['#000000', '#0B1A3A', '#2A1238', '#0A2A24'],
}

/**
 * Corners are concentric: an outer radius is the inner one plus the gap between them. A floating panel (22) holds rows
 * (16) six pixels in; a sheet (26) holds cards (16) ten pixels in. Buttons and other controls one presses are capsules.
 */
export const radius = {
  sheet: 26,
  window: 22,
  card: 16,
  control: 12,
  bubble: 20,
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
