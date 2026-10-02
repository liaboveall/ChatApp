import { expect } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Committed JSON snapshots make unintended contract changes visible (docs/08 section 2): a failing comparison is a
 * prompt to review the change. Regenerate on purpose with `UPDATE_SNAPSHOTS=1 bun run test:integration`.
 */
export function expectSnapshot(file: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    return
  }
  if (!existsSync(file)) {
    throw new Error(`snapshot ${file} does not exist; create it with UPDATE_SNAPSHOTS=1`)
  }
  expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(file, 'utf8')))
}
