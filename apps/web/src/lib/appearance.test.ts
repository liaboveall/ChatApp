import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  APPEARANCE_STORAGE_KEY,
  applyToRoot,
  DEFAULT_APPEARANCE,
  loadAppearance,
  startAppearance,
  useAppearance,
} from './appearance.ts'

// Vitest runs with apps/web as the working directory.
const themeInit = readFileSync(join(process.cwd(), 'public/theme-init.js'), 'utf8')

beforeEach(() => {
  localStorage.clear()
  for (const name of [
    'data-theme',
    'data-accent',
    'data-glass',
    'data-type-size',
    'data-reduce-motion',
  ])
    document.documentElement.removeAttribute(name)
  useAppearance.getState().reset()
})

const attributes = (): Record<string, string | null> =>
  Object.fromEntries(
    ['data-theme', 'data-accent', 'data-glass', 'data-type-size', 'data-reduce-motion'].map(
      (name) => [name, document.documentElement.getAttribute(name)],
    ),
  )

describe('loadAppearance', () => {
  test('nothing stored, garbage and wrong shapes all fall back to the defaults', () => {
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
    localStorage.setItem(APPEARANCE_STORAGE_KEY, '{not json')
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
    localStorage.setItem(APPEARANCE_STORAGE_KEY, '[1,2]')
    expect(loadAppearance()).toEqual(DEFAULT_APPEARANCE)
  })

  test('each bad field falls back on its own and the good ones are kept', () => {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        theme: 'dark',
        accent: 'chartreuse',
        glass: 'clear',
        typeSize: 99,
        reduceMotion: 'yes',
      }),
    )
    expect(loadAppearance()).toEqual({
      ...DEFAULT_APPEARANCE,
      theme: 'dark',
      glass: 'clear',
    })
  })
})

describe('applyToRoot', () => {
  test('defaults leave every attribute off, so the stylesheet defaults apply', () => {
    applyToRoot(DEFAULT_APPEARANCE)
    expect(attributes()).toEqual({
      'data-theme': null,
      'data-accent': null,
      'data-glass': null,
      'data-type-size': null,
      'data-reduce-motion': null,
    })
  })

  test('non-default choices become attributes', () => {
    applyToRoot({
      theme: 'dark',
      accent: 'purple',
      glass: 'tinted',
      typeSize: -1,
      reduceMotion: true,
      compactSidebar: true,
      timelineMode: 'paged',
    })
    expect(attributes()).toEqual({
      'data-theme': 'dark',
      'data-accent': 'purple',
      'data-glass': 'tinted',
      'data-type-size': '-1',
      'data-reduce-motion': 'true',
    })
  })
})

describe('the store', () => {
  test('changes are applied to <html> and saved', () => {
    const stop = startAppearance()
    useAppearance.getState().set('accent', 'green')
    useAppearance.getState().set('typeSize', 3)
    expect(document.documentElement.getAttribute('data-accent')).toBe('green')
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}')).toMatchObject({
      accent: 'green',
      typeSize: 3,
    })
    useAppearance.getState().reset()
    expect(document.documentElement.getAttribute('data-accent')).toBeNull()
    stop()
  })
})

describe('public/theme-init.js', () => {
  /** Runs the pre-paint script against a stored value and returns the attributes it set. */
  function runScript(stored: unknown): Record<string, string | null> {
    for (const name of [
      'data-theme',
      'data-accent',
      'data-glass',
      'data-type-size',
      'data-reduce-motion',
    ])
      document.documentElement.removeAttribute(name)
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      typeof stored === 'string' ? stored : JSON.stringify(stored),
    )
    new Function(themeInit)()
    return attributes()
  }

  test('applies exactly what applyToRoot applies, for every combination of choices', () => {
    for (const theme of ['system', 'light', 'dark'] as const)
      for (const accent of ['blue', 'purple', 'graphite'] as const)
        for (const glass of ['clear', 'standard', 'tinted', 'opaque'] as const)
          for (const typeSize of [-1, 0, 1, 3])
            for (const reduceMotion of [false, true]) {
              const value = { ...DEFAULT_APPEARANCE, theme, accent, glass, typeSize, reduceMotion }
              const fromScript = runScript(value)
              applyToRoot(value)
              expect(fromScript, JSON.stringify(value)).toEqual(attributes())
            }
  })

  test('survives unreadable and hostile storage without setting anything', () => {
    expect(runScript('{broken')).toEqual({
      'data-theme': null,
      'data-accent': null,
      'data-glass': null,
      'data-type-size': null,
      'data-reduce-motion': null,
    })
    const hostile = runScript({
      theme: '"><script>',
      accent: 'x y',
      glass: {},
      typeSize: '2',
      reduceMotion: 'true',
    })
    expect(Object.values(hostile).every((value) => value === null)).toBe(true)
  })
})
