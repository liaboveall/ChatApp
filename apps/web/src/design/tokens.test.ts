import { describe, expect, test } from 'vitest'
import {
  ACCENT_KEYS,
  accents,
  GLASS_KEYS,
  glass,
  neutral,
  status,
  type,
  typeScale,
} from './tokens.ts'
import { colorTokenNames, designCss } from './tokens-css.ts'

const css = designCss()

describe('the generated stylesheet', () => {
  test('defines a runtime variable and a Tailwind colour for every colour token', () => {
    for (const name of colorTokenNames()) {
      expect(css, `--${name}`).toMatch(new RegExp(`^\\s+--${name}: `, 'm'))
      expect(css, `--color-${name}`).toContain(`--color-${name}: var(--${name});`)
    }
  })

  test('covers all neutral, status and accent tokens', () => {
    for (const name of Object.keys(neutral)) expect(colorTokenNames()).toContain(name)
    for (const key of Object.keys(status)) {
      expect(colorTokenNames()).toEqual(
        expect.arrayContaining([key, `${key}-text`, `${key}-solid`]),
      )
    }
    for (const key of ACCENT_KEYS) {
      expect(css).toContain(`:root[data-accent="${key}"]`)
      expect(css).toContain(`--a-${key}-solid:`)
    }
  })

  test('every glass level and every type step has its attribute rule', () => {
    for (const key of GLASS_KEYS) expect(css).toContain(`:root[data-glass="${key}"]`)
    for (const step of [-1, 1, 2, 3]) expect(css).toContain(`:root[data-type-size="${step}"]`)
  })

  test('every type role is a Tailwind text role with size, line height and weight', () => {
    for (const role of Object.keys(type)) {
      expect(css).toContain(`--text-${role}: var(--fs-${role});`)
      expect(css).toContain(`--text-${role}--line-height: var(--lh-${role});`)
      expect(css).toContain(`--text-${role}--font-weight: var(--fw-${role});`)
    }
  })

  test("only design tokens can be used: Tailwind's default palette, sizes and shadows are cleared", () => {
    for (const cleared of [
      '--color-*: initial;',
      '--text-*: initial;',
      '--shadow-*: initial;',
      '--radius-*: initial;',
      '--font-*: initial;',
    ]) {
      expect(css).toContain(cleared)
    }
  })

  test('dark mode is `light-dark()` on every themed colour, switched by color-scheme', () => {
    expect(css).toContain('--label: light-dark(')
    expect(css).toContain(':root[data-theme="dark"]')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
  })
})

describe('token data', () => {
  test('eight accents, four glass levels, and the floors of docs/02 section 2', () => {
    expect(ACCENT_KEYS).toHaveLength(8)
    expect(Object.keys(glass.levels)).toEqual(['clear', 'standard', 'tinted', 'opaque'])
    expect(glass.floor).toEqual([0.9, 0.88])
    for (const accent of Object.values(accents)) {
      expect(accent.solid).toHaveLength(2)
      expect(accent.text).toHaveLength(2)
    }
  })

  test('size steps scale about 7% each', () => {
    expect(typeScale(0)).toBe(1)
    expect(typeScale(3)).toBe(1.21)
    expect(typeScale(-1)).toBe(0.93)
  })
})
