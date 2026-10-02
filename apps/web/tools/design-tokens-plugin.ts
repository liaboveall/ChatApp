/**
 * Writes `src/design/tokens.generated.css` from `src/design/tokens.ts` before any CSS is processed.
 *
 * Tailwind resolves `@import` on the file system, so the generated stylesheet has to be a real file. It is git-ignored
 * and rewritten only when its content changes. The token modules are dependencies of `vite.config.ts`, so Vite restarts
 * the dev server (and this plugin runs again) whenever they change.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { designCss } from '../src/design/tokens-css.ts'

const OUTPUT = fileURLToPath(new URL('../src/design/tokens.generated.css', import.meta.url))

export function writeDesignTokens(): boolean {
  const next = designCss()
  if (existsSync(OUTPUT) && readFileSync(OUTPUT, 'utf8') === next) return false
  writeFileSync(OUTPUT, next)
  return true
}

export function designTokens(): Plugin {
  return {
    name: 'chatapp:design-tokens',
    enforce: 'pre',
    config() {
      writeDesignTokens()
    },
  }
}
