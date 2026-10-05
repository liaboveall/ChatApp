/**
 * The code highlighter of the Markdown renderer (D-168), in the shape of Streamdown's `code` plugin. It replaces
 * `@streamdown/code` for one reason: that plugin turns every grammar's Oniguruma patterns into JavaScript regular expressions
 * the first time it tokenizes with it, which takes 150 ms for TypeScript in Chrome and 630 ms in Safari's engine, in the
 * middle of a scroll. Here the grammars come precompiled (`@shikijs/langs-precompiled`, the same grammars with the patterns
 * already turned into JavaScript regular expressions) and run on Shiki's raw JavaScript engine: 8 ms and 26 ms.
 *
 * What stays the way the original did it: one result per (language, themes, code) in a cache bounded by cost; a result for
 * a block that is still being written is not kept, and its tokenization continues from the last complete line of what was
 * tokenized before (the grammar state), so a long answer that streams in costs the new lines only; an answer is `null` while
 * the grammar is still being fetched and arrives by the callback; a language that is not supported is plain text. What is
 * different: one highlighter for everything (the original made one per language, and Shiki warns about more than ten), the
 * answer is given at once when the grammar is already loaded (no plain first draw), a failed load is not remembered (the next
 * ask tries again), and only the languages listed here are available (each is its own file, fetched when first needed).
 */
import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationAny } from 'shiki/core'
import { createJavaScriptRawEngine } from 'shiki/engine/javascript'
import type {
  BundledLanguage,
  CodeHighlighterPlugin,
  HighlightOptions,
  ThemeInput,
} from 'streamdown'

/** What a highlight answers with (Streamdown does not export the name). */
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>

type Loader = () => Promise<unknown>

/** The languages people paste into a chat, by Shiki's own names. A file each, so the build splits them. */
const GRAMMARS: Record<string, Loader> = {
  typescript: () => import('@shikijs/langs-precompiled/typescript'),
  tsx: () => import('@shikijs/langs-precompiled/tsx'),
  javascript: () => import('@shikijs/langs-precompiled/javascript'),
  jsx: () => import('@shikijs/langs-precompiled/jsx'),
  json: () => import('@shikijs/langs-precompiled/json'),
  jsonc: () => import('@shikijs/langs-precompiled/jsonc'),
  json5: () => import('@shikijs/langs-precompiled/json5'),
  html: () => import('@shikijs/langs-precompiled/html'),
  css: () => import('@shikijs/langs-precompiled/css'),
  scss: () => import('@shikijs/langs-precompiled/scss'),
  less: () => import('@shikijs/langs-precompiled/less'),
  yaml: () => import('@shikijs/langs-precompiled/yaml'),
  toml: () => import('@shikijs/langs-precompiled/toml'),
  diff: () => import('@shikijs/langs-precompiled/diff'),
  markdown: () => import('@shikijs/langs-precompiled/markdown'),
  sql: () => import('@shikijs/langs-precompiled/sql'),
  shellscript: () => import('@shikijs/langs-precompiled/shellscript'),
  powershell: () => import('@shikijs/langs-precompiled/powershell'),
  bat: () => import('@shikijs/langs-precompiled/bat'),
  python: () => import('@shikijs/langs-precompiled/python'),
  java: () => import('@shikijs/langs-precompiled/java'),
  kotlin: () => import('@shikijs/langs-precompiled/kotlin'),
  scala: () => import('@shikijs/langs-precompiled/scala'),
  swift: () => import('@shikijs/langs-precompiled/swift'),
  'objective-c': () => import('@shikijs/langs-precompiled/objective-c'),
  go: () => import('@shikijs/langs-precompiled/go'),
  rust: () => import('@shikijs/langs-precompiled/rust'),
  zig: () => import('@shikijs/langs-precompiled/zig'),
  c: () => import('@shikijs/langs-precompiled/c'),
  cpp: () => import('@shikijs/langs-precompiled/cpp'),
  csharp: () => import('@shikijs/langs-precompiled/csharp'),
  php: () => import('@shikijs/langs-precompiled/php'),
  ruby: () => import('@shikijs/langs-precompiled/ruby'),
  perl: () => import('@shikijs/langs-precompiled/perl'),
  lua: () => import('@shikijs/langs-precompiled/lua'),
  dart: () => import('@shikijs/langs-precompiled/dart'),
  r: () => import('@shikijs/langs-precompiled/r'),
  haskell: () => import('@shikijs/langs-precompiled/haskell'),
  elixir: () => import('@shikijs/langs-precompiled/elixir'),
  xml: () => import('@shikijs/langs-precompiled/xml'),
  vue: () => import('@shikijs/langs-precompiled/vue'),
  svelte: () => import('@shikijs/langs-precompiled/svelte'),
  graphql: () => import('@shikijs/langs-precompiled/graphql'),
  proto: () => import('@shikijs/langs-precompiled/proto'),
  ini: () => import('@shikijs/langs-precompiled/ini'),
  docker: () => import('@shikijs/langs-precompiled/docker'),
  make: () => import('@shikijs/langs-precompiled/make'),
  cmake: () => import('@shikijs/langs-precompiled/cmake'),
  nginx: () => import('@shikijs/langs-precompiled/nginx'),
  terraform: () => import('@shikijs/langs-precompiled/terraform'),
}

/** What a fence may call them, as Shiki does. */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  cts: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  bash: 'shellscript',
  sh: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  batch: 'bat',
  cmd: 'bat',
  py: 'python',
  kt: 'kotlin',
  kts: 'kotlin',
  objc: 'objective-c',
  rs: 'rust',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  rb: 'ruby',
  hs: 'haskell',
  yml: 'yaml',
  md: 'markdown',
  gql: 'graphql',
  protobuf: 'proto',
  properties: 'ini',
  dockerfile: 'docker',
  makefile: 'make',
  tf: 'terraform',
  tfvars: 'terraform',
}

/** The name Shiki knows a language by, or undefined for one this highlighter does not have. */
export function canonicalLanguage(language: string): string | undefined {
  const key = language.trim().toLowerCase()
  const id = ALIASES[key] ?? key
  return Object.hasOwn(GRAMMARS, id) ? id : undefined
}

const themeName = (theme: ThemeInput): string =>
  typeof theme === 'string' ? theme : (theme.name ?? 'custom')

/** Results kept, by cost (one per row of tokens and per 64 characters of the key) and by number, least recently used out first. */
const MAX_COST = 300_000
const MAX_RESULTS = 5_000
const CHARACTERS_PER_COST = 64
/** How many tokenizations of one language and theme can be continued from (the blocks being written, one each). */
const STATES_PER_LANGUAGE = 4

type Resumable = { grammarState: unknown; prefix: string; rows: HighlightResult['tokens'] }

export type CodePlugin = CodeHighlighterPlugin & {
  /** Fetches and registers the grammar of a language, so that the first block in it is drawn highlighted at once. */
  preload(language: string): Promise<void>
}

export function createCodePlugin(options: { themes: [ThemeInput, ThemeInput] }): CodePlugin {
  const { themes } = options
  const names: [string, string] = [themeName(themes[0]), themeName(themes[1])]

  let highlighter: HighlighterCore | undefined
  let starting: Promise<HighlighterCore> | undefined
  const loading = new Map<string, Promise<void>>()
  const loaded = new Set<string>()

  const start = (): Promise<HighlighterCore> => {
    starting ??= createHighlighterCore({
      themes: themes.filter((theme): theme is ThemeRegistrationAny => typeof theme !== 'string'),
      langs: [],
      engine: createJavaScriptRawEngine(),
    }).then(
      (created) => {
        highlighter = created
        return created
      },
      (error: unknown) => {
        starting = undefined
        throw error
      },
    )
    return starting
  }

  const load = (id: string): Promise<void> => {
    let pending = loading.get(id)
    if (pending === undefined) {
      const loader = GRAMMARS[id]
      pending = (async () => {
        const created = await start()
        await created.loadLanguage((await loader?.()) as never)
        loaded.add(id)
      })()
      // A failed load (the network dropped) is not kept: whoever asks next tries again.
      pending.catch(() => loading.delete(id))
      loading.set(id, pending)
    }
    return pending
  }

  const results = new Map<string, { cost: number; result: HighlightResult }>()
  let spent = 0
  const recall = (key: string): HighlightResult | undefined => {
    const entry = results.get(key)
    if (entry === undefined) return undefined
    results.delete(key)
    results.set(key, entry)
    return entry.result
  }
  const forget = (key: string): void => {
    const entry = results.get(key)
    if (entry === undefined) return
    results.delete(key)
    spent -= entry.cost
  }
  const remember = (key: string, result: HighlightResult): void => {
    forget(key)
    let cost = result.tokens.length + Math.ceil(key.length / CHARACTERS_PER_COST)
    for (const row of result.tokens) cost += row.length
    results.set(key, { cost, result })
    spent += cost
    while ((spent > MAX_COST || results.size > MAX_RESULTS) && results.size > 1) {
      const oldest = results.keys().next().value
      if (oldest === undefined) break
      forget(oldest)
    }
  }

  const resumables = new Map<string, Resumable[]>()
  const takeResumable = (key: string, code: string): Resumable | undefined => {
    const list = resumables.get(key)
    if (list === undefined) return undefined
    const at = list.findIndex((entry) => code.startsWith(entry.prefix))
    return at === -1 ? undefined : list.splice(at, 1)[0]
  }
  const putResumable = (key: string, entry: Resumable): void => {
    let list = resumables.get(key)
    if (list === undefined) {
      list = []
      resumables.set(key, list)
    }
    list.unshift(entry)
    if (list.length > STATES_PER_LANGUAGE) list.pop()
  }
  const shift = (rows: HighlightResult['tokens'], by: number): void => {
    if (by === 0) return
    for (const row of rows) for (const token of row) token.offset = (token.offset ?? 0) + by
  }

  /** Tokenizes `code`, starting from what an earlier, shorter version of the same block left (everything up to its last complete line). */
  const tokenize = (
    created: HighlighterCore,
    code: string,
    stateKey: string,
    lang: string,
  ): HighlightResult => {
    const variants = { light: names[0], dark: names[1] }
    const resumed = takeResumable(stateKey, code)
    let prefix = resumed?.prefix ?? ''
    let rows = resumed?.rows ?? []
    let grammarState = resumed?.grammarState
    const boundary = code.lastIndexOf('\n') + 1
    if (boundary > prefix.length) {
      const part = created.codeToTokens(code.slice(prefix.length, boundary), {
        lang,
        themes: variants,
        grammarState: grammarState as never,
      })
      const complete = part.tokens as unknown as HighlightResult['tokens']
      // The newline that ends the last complete line makes an empty row after it: that row belongs to the tail.
      complete.pop()
      shift(complete, prefix.length)
      rows = rows.concat(complete)
      grammarState = part.grammarState
      prefix = code.slice(0, boundary)
      putResumable(stateKey, { grammarState, prefix, rows })
    } else if (resumed !== undefined) {
      putResumable(stateKey, resumed)
    }
    const tail = created.codeToTokens(code.slice(boundary), {
      lang,
      themes: variants,
      grammarState: grammarState as never,
    })
    const tailRows = tail.tokens as unknown as HighlightResult['tokens']
    shift(tailRows, boundary)
    return { ...tail, tokens: rows.concat(tailRows) } as unknown as HighlightResult
  }

  const supportedLanguages = [
    ...Object.keys(GRAMMARS),
    ...Object.keys(ALIASES),
  ] as BundledLanguage[]

  return {
    name: 'shiki',
    type: 'code-highlighter',
    supportsLanguage: (language) => canonicalLanguage(language) !== undefined,
    getSupportedLanguages: () => supportedLanguages,
    getThemes: () => themes,
    preload: async (language) => {
      const id = canonicalLanguage(language)
      if (id !== undefined) await load(id)
    },
    highlight(
      { code, language, isIncomplete = false }: HighlightOptions,
      callback?: (result: HighlightResult) => void,
    ): HighlightResult | null {
      const id = canonicalLanguage(language)
      const lang = id ?? 'text'
      const key = `${lang}:${names[0]}:${names[1]}\n${code}`
      const known = recall(key)
      if (known !== undefined) return known

      const run = (created: HighlighterCore): HighlightResult => {
        const result =
          recall(key) ?? tokenize(created, code, `${lang}:${names[0]}:${names[1]}`, lang)
        if (!isIncomplete) remember(key, result)
        return result
      }
      // Everything needed is there: the answer is given now, not in a later task.
      if (highlighter !== undefined && (id === undefined || loaded.has(id))) return run(highlighter)

      // Not yet: the block is drawn as plain text, and the highlighted one follows when the grammar has arrived.
      void (id === undefined ? start() : load(id).then(start)).then(
        (created) => callback?.(run(created)),
        (error: unknown) =>
          console.warn(`[code] the grammar of "${lang}" could not be loaded`, error),
      )
      return null
    },
  }
}
