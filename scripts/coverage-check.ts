/**
 * bun scripts/coverage-check.ts [coverage/lcov.info]
 * Holds the directories named in scripts/lib/coverage.ts to their line-coverage floor (docs/08 section 7). Reads the lcov
 * file only; `bun run test:coverage` produces it and then runs this. Exit 0 when every gate passes, 1 when one fails, 2
 * when there is no coverage file to read.
 */
import { existsSync, readFileSync } from 'node:fs'
import { evaluate, GATES, parseLcov, report } from './lib/coverage.ts'

const path = process.argv[2] ?? 'coverage/lcov.info'
if (!existsSync(path)) {
  console.error(
    `no coverage file at ${path}: run \`bun run test:coverage\` (or bun test --coverage --coverage-reporter=lcov)`,
  )
  process.exit(2)
}
const results = evaluate(parseLcov(readFileSync(path, 'utf8')), GATES, existsSync)
console.log(report(results))
process.exit(results.every((r) => r.ok) ? 0 : 1)
