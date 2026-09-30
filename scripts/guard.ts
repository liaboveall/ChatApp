/**
 * Repository guard rails, run by `bun run check`, the pre-commit hook and CI:
 * - no raw-HTML sinks in app code (SEC-05); a line may opt out with `guard-allow: <reason>`
 * - no env files or rendered secrets tracked by git
 */
import { $, Glob } from 'bun'

const SINK =
  /\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML)\b|document\.write\(/
const SOURCES = new Glob('{apps,packages}/**/*.{ts,tsx,js,jsx,mjs,cjs}')
const problems: string[] = []

for await (const raw of SOURCES.scan({ cwd: '.', onlyFiles: true })) {
  const path = raw.replaceAll('\\', '/')
  if (path.includes('/node_modules/') || path.includes('/dist/')) continue
  const lines = (await Bun.file(path).text()).split('\n')
  lines.forEach((line, index) => {
    if (SINK.test(line) && !line.includes('guard-allow:')) {
      problems.push(`${path}:${index + 1}: raw HTML sink is forbidden (docs/07 SEC-05)`)
    }
  })
}

const tracked = (await $`git ls-files`.quiet().text()).split('\n').filter(Boolean)
for (const file of tracked) {
  const isEnvFile = /(^|\/)\.env(\.[^/]+)?$/.test(file) && !file.endsWith('.env.example')
  if (isEnvFile || file === 'infra/garage/garage.toml') {
    problems.push(`${file}: secrets file is tracked by git`)
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log('guard: ok')
