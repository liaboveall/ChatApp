import { describe, expect, test } from 'bun:test'
import { evaluate, type Gate, parseLcov, report } from './coverage.ts'

const record = (file: string, found: number, hit: number) =>
  `TN:\nSF:${file}\nFNF:1\nFNH:1\nDA:1,1\nLF:${found}\nLH:${hit}\nend_of_record\n`

const GATE: Gate = { dir: 'apps/server/src/domain/', label: 'domain', minLines: 90 }
const exists = () => true

describe('reading lcov', () => {
  test('takes the file name and the lines that can run and did run, record by record', () => {
    const text =
      record('apps/server/src/domain/a.ts', 20, 18) + record('apps/server/src/lib/b.ts', 4, 1)
    expect(parseLcov(text)).toEqual([
      { file: 'apps/server/src/domain/a.ts', found: 20, hit: 18 },
      { file: 'apps/server/src/lib/b.ts', found: 4, hit: 1 },
    ])
  })

  test('ignores noise and a record that never ends', () => {
    expect(parseLcov('nonsense\nSF:x.ts\nLF:3\nLH:3\n')).toEqual([])
    expect(parseLcov('')).toEqual([])
  })
})

describe('the gate of a directory', () => {
  test('is the lines hit over the lines found, across every file in it', () => {
    const [result] = evaluate(
      parseLcov(
        record('apps/server/src/domain/a.ts', 50, 50) +
          record('apps/server/src/domain/b.ts', 50, 40),
      ),
      [GATE],
      exists,
    )
    expect(result?.percent).toBe(90)
    expect(result?.ok).toBe(true) // exactly the floor passes
  })

  test('fails just under the floor and names the files that pull it down', () => {
    const results = evaluate(
      parseLcov(
        record('apps/server/src/domain/strong.ts', 500, 500) +
          record('apps/server/src/domain/weak.ts', 500, 399),
      ),
      [GATE],
      exists,
    )
    expect(results[0]?.ok).toBe(false)
    expect(results[0]?.percent).toBeCloseTo(89.9, 5) // 899 of 1000: a hair under the floor
    expect(report(results)).toContain('FAIL')
    expect(report(results)).toContain('apps/server/src/domain/weak.ts')
  })

  test('does not count tests, other directories or dependencies', () => {
    const [result] = evaluate(
      parseLcov(
        record('apps/server/src/domain/a.ts', 10, 10) +
          record('apps/server/src/domain/a.test.ts', 100, 0) +
          record('apps/server/test/integration/x.ts', 100, 0) +
          record('apps/server/src/http/routes/y.ts', 100, 0) +
          record('apps/server/src/domain/node_modules/z.ts', 100, 0),
      ),
      [GATE],
      exists,
    )
    expect(result).toMatchObject({ found: 10, hit: 10, ok: true })
  })

  test('with no data at all is a failure, not a pass: a run without --coverage must not look green', () => {
    const [result] = evaluate([], [GATE], exists)
    expect(result?.ok).toBe(false)
    expect(result?.note).toContain('no coverage data')
    const [empty] = evaluate(parseLcov(record('apps/server/src/domain/a.ts', 0, 0)), [GATE], exists)
    expect(empty?.ok).toBe(false)
  })

  test('of a directory that does not exist yet and may not (agent/, M4) is skipped, but only while it does not exist', () => {
    const agent: Gate = {
      dir: 'apps/server/src/agent/',
      label: 'agent',
      minLines: 90,
      optional: true,
    }
    const [skipped] = evaluate([], [agent], () => false)
    expect(skipped?.ok).toBe(true)
    // Once the directory has code, silence is a failure like for any other.
    const [present] = evaluate([], [agent], () => true)
    expect(present?.ok).toBe(false)
  })

  test('holds several directories to their own floors at once', () => {
    const results = evaluate(
      parseLcov(
        record('apps/server/src/domain/a.ts', 10, 10) + record('apps/server/src/agent/b.ts', 10, 5),
      ),
      [GATE, { dir: 'apps/server/src/agent/', label: 'agent', minLines: 90, optional: true }],
      exists,
    )
    expect(results.map((r) => r.ok)).toEqual([true, false])
  })
})
