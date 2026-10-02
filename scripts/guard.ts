/**
 * Repository guard rails, run by `bun run check`, the pre-commit hook and CI:
 * - no raw-HTML sinks in app code (SEC-05); a line may opt out with `guard-allow: <reason>`
 * - no env files (.env, .env.*, *.env) or rendered secrets tracked by git
 * - architecture boundaries between packages and server layers (docs/03 section 3, D-090)
 */
import { $, Glob } from 'bun'
import { checkFile } from './lib/boundaries.ts'

const SINK_NAMES = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'dangerouslySetInnerHTML',
  'setHTMLUnsafe',
  'createContextualFragment',
  'srcdoc',
  'srcDoc',
]
const SINK = new RegExp(`\\b(${SINK_NAMES.join('|')})\\b|document\\.write\\(`)
const ENV_FILE = /(^|\/)\.env(\.[^/]+)?$|\.env$/
const SOURCES = new Glob('{apps,packages}/**/*.{ts,tsx,js,jsx,mjs,cjs}')
/** Build output and tool reports are not source: they hold other people's bundled code. */
const NOT_SOURCE = [
  '/node_modules/',
  '/dist/',
  '/storybook-static/',
  '/playwright-report/',
  '/test-results/',
  '/coverage/',
]
const problems: string[] = []

for await (const raw of SOURCES.scan({ cwd: '.', onlyFiles: true })) {
  const path = raw.replaceAll('\\', '/')
  if (NOT_SOURCE.some((part) => path.includes(part))) continue
  const text = await Bun.file(path).text()
  text.split('\n').forEach((line, index) => {
    if (SINK.test(line) && !line.includes('guard-allow:')) {
      problems.push(`${path}:${index + 1}: raw HTML sink is forbidden (docs/07 SEC-05)`)
    }
  })
  problems.push(...checkFile(path, text))
}

const tracked = (await $`git ls-files`.quiet().text()).split('\n').filter(Boolean)
for (const file of tracked) {
  const isEnvFile = ENV_FILE.test(file) && !file.endsWith('.env.example')
  if (isEnvFile || file === 'infra/garage/garage.toml') {
    problems.push(`${file}: secrets file is tracked by git`)
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('guard: ok')
