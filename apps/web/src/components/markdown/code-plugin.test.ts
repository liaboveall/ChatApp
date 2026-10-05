import { createCssVariablesTheme } from 'shiki/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { canonicalLanguage, createCodePlugin } from './code-plugin.ts'

const theme = createCssVariablesTheme({
  name: 'test-css-vars',
  variablePrefix: '--shiki-',
  variableDefaults: {},
  fontStyle: true,
})
const themes: [typeof theme, typeof theme] = [theme, theme]
const make = () => createCodePlugin({ themes })

/** The answer a highlight gives once it has one: at once if it can, otherwise by the callback. */
function answer(plugin: ReturnType<typeof make>, code: string, language: string) {
  return new Promise<ReturnType<typeof plugin.highlight>>((resolve) => {
    const now = plugin.highlight({ code, language: language as never, themes }, (result) =>
      resolve(result),
    )
    if (now !== null) resolve(now)
  })
}

const TS = 'const total = items.reduce((sum, item) => sum + item.price, 0)\nconsole.log(total)'

describe('the names of languages (D-168)', () => {
  test('a fence may use Shiki’s aliases, in any case and with spaces around', () => {
    expect(canonicalLanguage('ts')).toBe('typescript')
    expect(canonicalLanguage(' TS ')).toBe('typescript')
    expect(canonicalLanguage('bash')).toBe('shellscript')
    expect(canonicalLanguage('c++')).toBe('cpp')
    expect(canonicalLanguage('python')).toBe('python')
  })

  test('what is not listed is not a language (and "constructor" is not one either)', () => {
    expect(canonicalLanguage('klingon')).toBeUndefined()
    expect(canonicalLanguage('')).toBeUndefined()
    expect(canonicalLanguage('constructor')).toBeUndefined()
    expect(canonicalLanguage('__proto__')).toBeUndefined()
  })

  test('the plugin says which it supports', () => {
    const plugin = make()
    expect(plugin.supportsLanguage('ts' as never)).toBe(true)
    expect(plugin.supportsLanguage('klingon' as never)).toBe(false)
    expect(plugin.getSupportedLanguages()).toContain('typescript')
    expect(plugin.getSupportedLanguages()).toContain('ts')
  })
})

describe('highlighting', () => {
  test('is null while the grammar is fetched, arrives by the callback, and is then given at once and not again computed', async () => {
    const plugin = make()
    expect(plugin.highlight({ code: TS, language: 'ts' as never, themes })).toBeNull()
    const first = await answer(plugin, TS, 'ts')
    expect(first?.tokens).toHaveLength(2)
    // What the theme says about the keyword: a colour variable of the page, never a literal colour.
    const keyword = first?.tokens[0]?.find((token) => token.content === 'const')
    expect(keyword?.htmlStyle ?? keyword?.color).toBeDefined()
    const again = plugin.highlight({ code: TS, language: 'typescript' as never, themes })
    expect(again).toBe(first)
  })

  test('the text of the tokens is the code, line by line, with their offsets counting from the start of the code', async () => {
    const plugin = make()
    const result = await answer(plugin, TS, 'ts')
    const lines = TS.split('\n')
    expect(result?.tokens.map((row) => row.map((token) => token.content).join(''))).toEqual(lines)
    let offset = 0
    for (const [index, row] of (result?.tokens ?? []).entries()) {
      expect(row[0]?.offset).toBe(offset)
      offset += (lines[index]?.length ?? 0) + 1
    }
  })

  test('a language that is not supported is plain text: one run of text per line, nothing coloured by a grammar', async () => {
    const plugin = make()
    const result = await answer(plugin, 'a b\nc d', 'klingon')
    expect(result?.tokens.map((row) => row.map((token) => token.content).join(''))).toEqual([
      'a b',
      'c d',
    ])
  })

  test('preloading a language makes its first block answer at once', async () => {
    const plugin = make()
    await plugin.preload('python')
    const now = plugin.highlight({
      code: 'def f(x):\n    return x\n',
      language: 'py' as never,
      themes,
    })
    expect(now).not.toBeNull()
    expect(now?.tokens[0]?.map((token) => token.content).join('')).toBe('def f(x):')
  })

  test('preloading something that is not a language does nothing', async () => {
    await expect(make().preload('klingon')).resolves.toBeUndefined()
  })
})

describe('a block that is still being written (streaming)', () => {
  const code = [
    'function total(items: Item[]): number {',
    '  let sum = 0',
    '  for (const item of items) {',
    '    sum += item.price * item.count // each',
    '  }',
    '  return sum',
    '}',
    'export default total',
  ].join('\n')

  test('every prefix, written piece by piece, gives what the whole text gives when it is highlighted at once', async () => {
    const streaming = make()
    await streaming.preload('ts')
    const flat = (result: ReturnType<typeof streaming.highlight>) =>
      JSON.stringify(
        result?.tokens.map((row) => row.map((t) => [t.content, t.htmlStyle ?? t.color, t.offset])),
      )
    let last: ReturnType<typeof streaming.highlight> = null
    for (let end = 7; end <= code.length; end += 7) {
      last = streaming.highlight({
        code: code.slice(0, end),
        language: 'ts' as never,
        themes,
        isIncomplete: true,
      })
      expect(last).not.toBeNull()
      const fresh = make()
      await fresh.preload('ts')
      const whole = fresh.highlight({ code: code.slice(0, end), language: 'ts' as never, themes })
      expect(flat(last)).toBe(flat(whole))
    }
    // The last piece may be shorter than seven characters.
    last = streaming.highlight({ code, language: 'ts' as never, themes, isIncomplete: true })
    const fresh = make()
    await fresh.preload('ts')
    expect(flat(last)).toBe(flat(fresh.highlight({ code, language: 'ts' as never, themes })))
  })

  test('an unfinished block is not kept: the same text, finished, is worked out and then kept', async () => {
    const plugin = make()
    await plugin.preload('ts')
    const unfinished = plugin.highlight({
      code,
      language: 'ts' as never,
      themes,
      isIncomplete: true,
    })
    const finished = plugin.highlight({ code, language: 'ts' as never, themes })
    expect(finished).not.toBe(unfinished)
    expect(plugin.highlight({ code, language: 'ts' as never, themes })).toBe(finished)
  })
})

describe('when the grammar cannot be fetched', () => {
  afterEach(() => {
    vi.doUnmock('@shikijs/langs-precompiled/typescript')
    vi.resetModules()
  })

  test('the failure is not remembered: the next ask fetches again', async () => {
    let attempts = 0
    vi.resetModules()
    vi.doMock('@shikijs/langs-precompiled/typescript', async (importOriginal) => {
      attempts += 1
      if (attempts === 1) throw new Error('the network dropped')
      return await importOriginal()
    })
    const fresh = await import('./code-plugin.ts')
    const plugin = fresh.createCodePlugin({ themes })
    await expect(plugin.preload('ts')).rejects.toThrow()
    await expect(plugin.preload('ts')).resolves.toBeUndefined()
    expect(attempts).toBe(2)
    expect(plugin.highlight({ code: TS, language: 'ts' as never, themes })).not.toBeNull()
  })
})
