#!/usr/bin/env bun
/**
 * Writes `messages/zh-CN.json` and `messages/en.json` from `tools/messages-source.ts`, and checks them against the code:
 * every `m.<key>(` used under `src/` must exist, and no message may go unused.
 *
 *   bun apps/web/tools/generate-messages.ts           write the files
 *   bun apps/web/tools/generate-messages.ts --check   verify only (used by `bun run check`); exit 1 on any difference
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Entry, MESSAGES } from './messages-source.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCHEMA = 'https://inlang.com/schema/inlang-message-format'
const check = process.argv.includes('--check')

function render(locale: 'zh' | 'en'): Record<string, unknown> {
  const out: Record<string, unknown> = { $schema: SCHEMA }
  for (const [key, entry] of Object.entries(MESSAGES)) out[key] = value(entry, locale)
  return out
}

function value(entry: Entry, locale: 'zh' | 'en'): unknown {
  if ('plural' in entry) {
    if (locale === 'zh') return entry.zh
    return [
      {
        declarations: [
          `input ${entry.param}`,
          `local ${entry.param}Plural = ${entry.param}: plural`,
        ],
        selectors: [`${entry.param}Plural`],
        match: {
          [`${entry.param}Plural=one`]: entry.plural.one,
          [`${entry.param}Plural=other`]: entry.plural.other,
        },
      },
    ]
  }
  return entry[locale]
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name)
    if (item.isDirectory()) return item.name === 'paraglide' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(item.name) && !/\.(test|stories)\./.test(item.name) ? [path] : []
  })
}

const problems: string[] = []

// Placeholders must agree between the two languages.
for (const [key, entry] of Object.entries(MESSAGES)) {
  const texts =
    'plural' in entry ? [entry.zh, entry.plural.one, entry.plural.other] : [entry.zh, entry.en]
  const names = texts.map((text) =>
    [...text.matchAll(/\{(\w+)\}/g)]
      .map((hit) => hit[1])
      .sort()
      .join(','),
  )
  if (new Set(names).size > 1)
    problems.push(`${key}: the languages use different {placeholders} (${names.join(' | ')})`)
}

// Keys used by the code against keys defined.
const used = new Set<string>()
for (const file of sourceFiles(join(ROOT, 'src'))) {
  for (const hit of readFileSync(file, 'utf8').matchAll(/\bm\.([a-z][a-z0-9_]*)\(/g)) {
    if (hit[1]) used.add(hit[1])
  }
}
for (const key of used) if (!(key in MESSAGES)) problems.push(`used but not defined: ${key}`)
for (const key of Object.keys(MESSAGES))
  if (!used.has(key)) problems.push(`defined but never used: ${key}`)

const files = { 'zh-CN': render('zh'), en: render('en') }
for (const [locale, content] of Object.entries(files)) {
  const path = join(ROOT, 'messages', `${locale}.json`)
  if (check) {
    let current: unknown
    try {
      current = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      current = undefined
    }
    if (JSON.stringify(current) !== JSON.stringify(content)) {
      problems.push(
        `messages/${locale}.json is out of date; run: bun apps/web/tools/generate-messages.ts`,
      )
    }
  } else {
    writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`)
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(
  check
    ? `messages ok: ${Object.keys(MESSAGES).length} keys, 2 languages`
    : `wrote ${Object.keys(MESSAGES).length} messages × 2 languages`,
)
