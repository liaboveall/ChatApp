/**
 * Turns `tokens.ts` into the stylesheet the app imports: the runtime custom properties (switchable by `data-theme`,
 * `data-accent`, `data-glass` and `data-type-size` on <html>) and the Tailwind 4 theme that exposes them as utilities.
 *
 * Colours use `light-dark()` and follow `color-scheme`: `:root` is light, `prefers-color-scheme: dark` flips it unless
 * `data-theme="light"` is set, and `data-theme="dark"` forces it. Non-colour tokens that differ by theme use the same
 * three blocks, because `light-dark()` only accepts colours.
 *
 * The output is written to `tokens.generated.css` (git-ignored) by the Vite plugin in `tools/design-tokens-plugin.ts`;
 * Tailwind cannot import a virtual module, so the plugin writes a real file before any CSS is processed.
 */
import {
  ACCENT_ON,
  accents,
  code,
  DEFAULT_ACCENT,
  DEFAULT_GLASS,
  fontStacks,
  glass,
  neutral,
  type Pair,
  radius,
  SELECTED_TINT,
  springEasing,
  springs,
  status,
  type,
  typeScale,
  wallpaper,
} from './tokens.ts'

const pair = ([light, dark]: Pair): string => `light-dark(${light}, ${dark})`

/** Runtime custom properties on :root and the attribute-driven overrides. */
function runtimeCss(): string {
  const root: string[] = []
  const add = (name: string, value: string): void => {
    root.push(`  --${name}: ${value};`)
  }

  for (const [name, value] of Object.entries(neutral)) add(name, pair(value))
  add('placeholder', 'var(--label-tertiary)')
  for (const [name, value] of Object.entries(code)) add(`code-${name}`, pair(value))
  add('on-accent', pair(ACCENT_ON))

  for (const [key, entry] of Object.entries(status)) {
    add(key, pair(entry.deco))
    add(`${key}-text`, pair(entry.text))
    add(`${key}-solid`, pair(entry.solid))
  }

  for (const [key, accent] of Object.entries(accents)) {
    add(`a-${key}-deco`, pair(accent.deco))
    add(`a-${key}-solid`, pair(accent.solid))
    add(`a-${key}-text`, pair(accent.text))
  }
  add('accent', `var(--a-${DEFAULT_ACCENT}-deco)`)
  add('accent-solid', `var(--a-${DEFAULT_ACCENT}-solid)`)
  add('accent-text', `var(--a-${DEFAULT_ACCENT}-text)`)
  add('bubble-out', 'var(--accent-solid)')
  add('focus-ring', 'var(--accent-text)')

  add('glass-base', pair(glass.base))
  const level = glass.levels[DEFAULT_GLASS]
  add('glass-alpha', `${level.alpha * 100}%`)
  add('glass-blur', `${level.blur}px`)
  add('glass-saturate', String(level.saturate))
  add('glass-tint', `${level.tint * 100}%`)
  add('glass-floor', `${glass.floor[0] * 100}%`)
  add('wallpaper-tint', `${wallpaper.maxTint[0] * 100}%`)
  add('sel-tint', `${SELECTED_TINT * 100}%`)

  add('type-scale', '1')
  for (const [key, [size, line, weight]] of Object.entries(type)) {
    add(`fs-${key}`, `calc(${size / 16}rem * var(--type-scale))`)
    add(`lh-${key}`, `calc(${line / 16}rem * var(--type-scale))`)
    add(`fw-${key}`, String(weight))
  }

  for (const [key, spring] of Object.entries(springs)) {
    const { duration, easing } = springEasing(spring)
    add(`spring-${key}`, easing)
    add(`dur-${key}`, `${duration}ms`)
  }
  add('dur-fade', '200ms')

  const out: string[] = [':root {', '  color-scheme: light;', ...root, '}']
  out.push(
    `@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --glass-floor: ${glass.floor[1] * 100}%;
    --wallpaper-tint: ${wallpaper.maxTint[1] * 100}%;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --glass-floor: ${glass.floor[1] * 100}%;
  --wallpaper-tint: ${wallpaper.maxTint[1] * 100}%;
}
:root[data-theme="light"] {
  color-scheme: light;
}`,
  )

  for (const key of Object.keys(accents)) {
    out.push(
      `:root[data-accent="${key}"] {
  --accent: var(--a-${key}-deco);
  --accent-solid: var(--a-${key}-solid);
  --accent-text: var(--a-${key}-text);
}`,
    )
  }

  for (const [key, entry] of Object.entries(glass.levels)) {
    out.push(
      `:root[data-glass="${key}"] {
  --glass-alpha: ${entry.alpha * 100}%;
  --glass-blur: ${entry.blur}px;
  --glass-saturate: ${entry.saturate};
  --glass-tint: ${entry.tint * 100}%;
}`,
    )
  }

  // Type size steps -1 .. +3 (spec 4.3).
  for (const step of [-1, 1, 2, 3]) {
    out.push(`:root[data-type-size="${step}"] {\n  --type-scale: ${typeScale(step).toFixed(2)};\n}`)
  }

  return out.join('\n')
}

/** Colour token names that become Tailwind colour utilities (`bg-label`, `text-accent-text`, ...). */
export function colorTokenNames(): string[] {
  return [
    ...Object.keys(neutral),
    'placeholder',
    ...Object.keys(code).map((name) => `code-${name}`),
    'on-accent',
    ...Object.keys(status).flatMap((key) => [key, `${key}-text`, `${key}-solid`]),
    'accent',
    'accent-solid',
    'accent-text',
    'bubble-out',
    'focus-ring',
    'glass-base',
  ]
}

/**
 * The Tailwind 4 theme. Defaults are cleared so only design tokens can be used: a colour, radius, type role or shadow
 * that is not in `tokens.ts` has no utility. Colours and type roles are `inline`, so utilities point at the runtime
 * custom properties and follow `data-theme`, `data-accent` and `data-type-size` without a rebuild.
 */
function themeCss(): string {
  const colors = colorTokenNames().map((name) => `  --color-${name}: var(--${name});`)
  const roles = Object.keys(type).flatMap((key) => [
    `  --text-${key}: var(--fs-${key});`,
    `  --text-${key}--line-height: var(--lh-${key});`,
    `  --text-${key}--font-weight: var(--fw-${key});`,
  ])
  const radii = Object.entries(radius).map(([key, value]) => `  --radius-${key}: ${value}px;`)
  const eases = Object.entries(springs).map(
    ([key, spring]) => `  --ease-${key}: ${springEasing(spring).easing};`,
  )
  return [
    '@theme inline {',
    '  --color-*: initial;',
    ...colors,
    '  --text-*: initial;',
    ...roles,
    '  --shadow-*: initial;',
    '  --shadow-elev-1: var(--elev-1);',
    '  --shadow-elev-2: var(--elev-2);',
    '}',
    '',
    // static: hand-written component CSS reads these by name, so they are emitted even when no utility uses them.
    '@theme static {',
    '  --radius-*: initial;',
    ...radii,
    '  --font-*: initial;',
    `  --font-sans: ${fontStacks.sans};`,
    `  --font-mono: ${fontStacks.mono};`,
    '  --ease-*: initial;',
    ...eases,
    '}',
  ].join('\n')
}

export function designCss(): string {
  return [
    '/* Generated from src/design/tokens.ts by tools/design-tokens-plugin.ts. Do not edit; it is git-ignored. */',
    runtimeCss(),
    themeCss(),
    '',
  ].join('\n')
}
