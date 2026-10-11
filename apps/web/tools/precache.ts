/**
 * What the service worker keeps (docs/03 section 11, M6): the public shell, which is the page, its scripts and styles, the
 * fonts and the icons. The code highlighter's grammars are separate chunks that are read when somebody pastes that language
 * (megabytes in all, one of them a megabyte by itself), so they stay out of the list; they are fetched when needed, like before.
 */

/** The language names `components/markdown/code-plugin.ts` loads, read from its own imports so the two cannot drift apart. */
export function grammarNames(source: string): string[] {
  return [...source.matchAll(/import\('@shikijs\/langs-precompiled\/([\w-]+)'\)/g)].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  )
}

/** The length of the content hash the build puts at the end of a chunk's name (`typescript-CZkDpd9W.js`). */
export const CHUNK_HASH_LENGTH = 8

/**
 * Globs for `injectManifest.globIgnores`: the built chunk of each grammar is `assets/<language>-<hash>.js`. The hash is matched
 * by its exact length, because a looser pattern also takes chunks that merely begin with a language's name: `jsx-*` would
 * leave out React's `jsx-runtime-<hash>.js`, and the app would not start offline.
 */
export function precacheIgnores(codePluginSource: string): string[] {
  const names = grammarNames(codePluginSource)
  if (names.length === 0) {
    throw new Error('code-plugin.ts lists no grammars: the precache rule is out of date')
  }
  return [`assets/{${names.join(',')}}-${'?'.repeat(CHUNK_HASH_LENGTH)}.js`]
}
