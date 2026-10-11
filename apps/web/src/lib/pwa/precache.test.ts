import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { grammarNames, precacheIgnores } from '../../../tools/precache.ts'

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../components/markdown/code-plugin.ts'),
  'utf8',
)

describe('what the service worker leaves out of its keeping', () => {
  test('every grammar the highlighter can load is on the list, and nothing else', () => {
    const names = grammarNames(SOURCE)
    expect(names.length).toBeGreaterThan(30)
    expect(names).toContain('typescript')
    expect(names).toContain('objective-c')
    expect(names).toContain('cpp')
    expect(new Set(names).size).toBe(names.length)
    // The same number of loaders as names: a loader written another way would be missed by the rule.
    expect(SOURCE.match(/langs-precompiled\//g)?.length).toBe(names.length)
  })

  /** Enough of a glob for this one pattern: `{a,b}` alternatives and `?`. */
  const matches = (glob: string, path: string): boolean => {
    const source = glob
      .replace(/[.+^$()|[\]\\]/g, '\\$&')
      .replaceAll('?', '[^/]')
      .replace(/\{([^}]*)\}/g, (_, list: string) => `(?:${list.split(',').join('|')})`)
    return new RegExp(`^${source}$`).test(path)
  }

  test('the glob takes the hashed chunk of every grammar and nothing that only begins with its name', () => {
    const [glob] = precacheIgnores(SOURCE)
    expect(glob).toContain('{typescript,')
    for (const name of grammarNames(SOURCE)) {
      expect(matches(glob ?? '', `assets/${name}-CZkDpd9W.js`)).toBe(true)
      expect(matches(glob ?? '', `assets/${name}-GBS__Bbt.js`)).toBe(true)
    }
    // Chunks of the app and of React whose names start with a language's: they must stay in the shell.
    for (const path of [
      'assets/jsx-runtime-Cuk4mU0H.js',
      'assets/c-runtime-Cuk4mU0H.js',
      'assets/html-body-KQOG7T2V-BOKf64C1.js',
      'assets/json-schema-B4F1jCZh.js',
      'assets/markdown-extra-I-N90ZJR.js',
      'assets/web-cvmSuVIq.js',
      'assets/rolldown-runtime-8BhlS34s.js',
      'assets/css-modules-Abcdefgh.js',
      'assets/typescript-CZkDpd9W.css',
    ]) {
      expect(matches(glob ?? '', path)).toBe(false)
    }
  })

  test('an empty list is an error, not an empty rule', () => {
    expect(() => precacheIgnores('export const x = 1')).toThrow()
  })
})
