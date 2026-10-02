/**
 * Generates the token layer of the prototype's CSS from `tokens.mjs`.
 *
 * Colours use `light-dark()` and follow `color-scheme`, which is set by the page contract:
 * `:root` is light, `prefers-color-scheme: dark` flips it unless `data-theme="light"` is set, and
 * `data-theme="dark"` forces it. Non-colour tokens that differ by theme use the same three blocks,
 * because `light-dark()` only accepts colours.
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
  radius,
  SELECTED_TINT,
  space,
  springEasing,
  springs,
  status,
  type,
  wallpaper,
} from './tokens.mjs'

const pair = ([light, dark]) => `light-dark(${light}, ${dark})`

export function tokensCss() {
  const out = []
  const root = []
  const add = (name, value) => root.push(`  --${name}: ${value};`)

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

  for (const [key, value] of Object.entries(radius)) add(`radius-${key}`, `${value}px`)
  for (const [index, value] of space.entries()) add(`space-${index + 1}`, `${value}px`)

  add('type-scale', '1')
  for (const [key, [size, line, weight]] of Object.entries(type)) {
    add(`fs-${key}`, `calc(${size / 16}rem * var(--type-scale))`)
    add(`lh-${key}`, `calc(${line / 16}rem * var(--type-scale))`)
    add(`fw-${key}`, String(weight))
  }
  add('font-sans', fontStacks.system)
  add('font-mono', fontStacks.mono)

  for (const [key, spring] of Object.entries(springs)) {
    const { duration, easing } = springEasing(spring)
    add(`spring-${key}`, easing)
    add(`dur-${key}`, `${duration}ms`)
  }
  add('dur-fade', '200ms')

  out.push(':root {', '  color-scheme: light;', ...root, '}')
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

  // Type size steps -1 .. +3 (spec 4.3): about 7% per step on every size.
  for (const step of [-1, 1, 2, 3]) {
    out.push(
      `:root[data-type-size="${step}"] {\n  --type-scale: ${(1 + step * 0.07).toFixed(2)};\n}`,
    )
  }

  return out.join('\n')
}
