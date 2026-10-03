/**
 * Line coverage per directory (docs/08 section 7). `bun test` can only set one global threshold, so the directories that
 * carry the rules of the application are held to their own: the business logic in `domain/` (authorization, visibility,
 * every policy) and, once it exists, `agent/` (policy, budget, side-effect ledger) must reach 90 % of their lines. The
 * input is the lcov file that `bun test --coverage --coverage-reporter=lcov` writes; nothing here runs tests.
 */

export type FileCoverage = { file: string; found: number; hit: number }

export type Gate = {
  /** Repository-relative directory, with a trailing slash. */
  dir: string
  label: string
  minLines: number
  /** The directory may not exist yet (agent/ arrives with M4): then there is nothing to hold to the gate. */
  optional?: boolean
}

export const GATES: readonly Gate[] = [
  { dir: 'apps/server/src/domain/', label: 'domain', minLines: 90 },
  { dir: 'apps/server/src/agent/', label: 'agent', minLines: 90, optional: true },
]

/** Test code and dependencies are never what is being measured. */
const isMeasured = (file: string): boolean =>
  !/\.test\.[cm]?[jt]sx?$/.test(file) && !file.includes('/test/') && !file.includes('node_modules/')

/** Reads the records of an lcov file: `SF:` names the file, `LF:` the lines that can run, `LH:` those that did. */
export function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = []
  let current: FileCoverage | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      current = { file: line.slice(3).trim(), found: 0, hit: 0 }
    } else if (current && line.startsWith('LF:')) {
      current.found = Number(line.slice(3))
    } else if (current && line.startsWith('LH:')) {
      current.hit = Number(line.slice(3))
    } else if (line.startsWith('end_of_record') && current) {
      files.push(current)
      current = undefined
    }
  }
  return files
}

export type GateResult = {
  gate: Gate
  files: FileCoverage[]
  found: number
  hit: number
  /** Null when there was nothing to measure. */
  percent: number | null
  ok: boolean
  note: string
}

export function evaluate(
  files: readonly FileCoverage[],
  gates: readonly Gate[],
  directoryExists: (dir: string) => boolean,
): GateResult[] {
  return gates.map((gate) => {
    const inside = files.filter((f) => f.file.startsWith(gate.dir) && isMeasured(f.file))
    if (inside.length === 0) {
      if (gate.optional && !directoryExists(gate.dir)) {
        return {
          gate,
          files: inside,
          found: 0,
          hit: 0,
          percent: null,
          ok: true,
          note: 'not created yet, nothing to hold to the gate',
        }
      }
      return {
        gate,
        files: inside,
        found: 0,
        hit: 0,
        percent: null,
        ok: false,
        note: 'no coverage data: were the tests run with --coverage and the lcov reporter?',
      }
    }
    const found = inside.reduce((sum, f) => sum + f.found, 0)
    const hit = inside.reduce((sum, f) => sum + f.hit, 0)
    if (found === 0) {
      return {
        gate,
        files: inside,
        found,
        hit,
        percent: null,
        ok: false,
        note: 'the files report no lines that can run',
      }
    }
    const percent = (hit / found) * 100
    return { gate, files: inside, found, hit, percent, ok: percent >= gate.minLines, note: '' }
  })
}

/** A table a human can act on: each gate, its result, and the files that pull it down. */
export function report(results: readonly GateResult[]): string {
  const lines: string[] = []
  for (const r of results) {
    const mark = r.ok ? 'ok  ' : 'FAIL'
    const figure =
      r.percent === null
        ? r.note
        : `${r.percent.toFixed(2)}% of ${r.found} lines in ${r.files.length} files (needs ${r.gate.minLines}%)`
    lines.push(`${mark} ${r.gate.label.padEnd(8)} ${r.gate.dir}  ${figure}`)
    if (r.percent !== null && !r.ok) {
      const worst = [...r.files]
        .filter((f) => f.found > 0)
        .sort((a, b) => a.hit / a.found - b.hit / b.found)
        .slice(0, 5)
      for (const f of worst) {
        lines.push(
          `       ${((f.hit / f.found) * 100).toFixed(1).padStart(5)}%  ${f.hit}/${f.found}  ${f.file}`,
        )
      }
    }
  }
  return lines.join('\n')
}
