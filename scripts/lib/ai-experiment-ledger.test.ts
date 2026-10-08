import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExperimentLedger } from './ai-experiment-ledger.ts'

const price = { version: 'test', input: 1_000_000, cachedInput: 0, output: 1_000_000 }
const attempt = (id: string) => ({
  id,
  label: 'fixture',
  model: 'mock',
  price,
  inputTokenBound: 10,
  maxOutputTokens: 10,
})
const usage = { inputTokens: 2, outputTokens: 3, cachedTokens: 0, reasoningTokens: 1 }

describe('durable experiment budget', () => {
  test('only the first of four submissions fits a one-call budget', () => {
    const ledger = new ExperimentLedger(':memory:', 20)
    try {
      ledger.reserve(attempt('first'))
      for (const id of ['second', 'third', 'fourth'])
        expect(() => ledger.reserve(attempt(id))).toThrow('BUDGET_EXHAUSTED')
      expect(ledger.snapshot().availableMicroUsd).toBe(0)
    } finally {
      ledger.close()
    }
  })
  test('unknown cannot be released or replayed, but late usage settles once', () => {
    const ledger = new ExperimentLedger(':memory:', 20)
    try {
      ledger.reserve(attempt('call'))
      ledger.start('call')
      ledger.unknown('call')
      expect(() => ledger.release('call')).toThrow('ATTEMPT_CONFLICT')
      expect(() => ledger.start('call')).toThrow('ATTEMPT_CONFLICT')
      expect(ledger.snapshot().unknownMicroUsd).toBe(20)
      ledger.settle('call', usage)
      ledger.settle('call', usage)
      ledger.unknown('call')
      expect(ledger.snapshot()).toMatchObject({
        settledMicroUsd: 5,
        unknownMicroUsd: 0,
        availableMicroUsd: 15,
      })
      expect(() => ledger.settle('call', { ...usage, outputTokens: 4 })).toThrow('ATTEMPT_CONFLICT')
    } finally {
      ledger.close()
    }
  })
  test('records real overage and halts admission instead of hiding an exceeded bound', () => {
    const ledger = new ExperimentLedger(':memory:', 1000)
    try {
      ledger.reserve(attempt('overage'))
      ledger.start('overage')
      ledger.settle('overage', { ...usage, outputTokens: 30 })
      expect(ledger.snapshot()).toMatchObject({ settledMicroUsd: 32, halted: true })
      expect(() => ledger.reserve(attempt('next'))).toThrow('BUDGET_HALTED')
    } finally {
      ledger.close()
    }
  })
  test('process restart retains started attempts and refuses to reset the budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chatapp-ai-budget-'))
    const path = join(dir, 'budget.sqlite')
    try {
      const first = new ExperimentLedger(path, 20)
      first.reserve(attempt('started'))
      first.start('started')
      first.close()
      const second = new ExperimentLedger(path, 20)
      expect(second.snapshot().availableMicroUsd).toBe(0)
      expect(() => second.reserve(attempt('again'))).toThrow('BUDGET_EXHAUSTED')
      second.close()
      expect(() => new ExperimentLedger(path, 21)).toThrow('ATTEMPT_CONFLICT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test('four independent processes cannot overspend the same persisted account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chatapp-ai-race-'))
    const path = join(dir, 'budget.sqlite')
    const module = new URL('./ai-experiment-ledger.ts', import.meta.url).pathname
    const init = new ExperimentLedger(path, 20)
    init.close()
    try {
      const outcomes = await Promise.all(
        [0, 1, 2, 3].map(async (id) => {
          const code = `import { ExperimentLedger } from ${JSON.stringify(module)}; const ledger = new ExperimentLedger(${JSON.stringify(path)},20); try { ledger.reserve(${JSON.stringify(attempt(String(id)))}); console.log("accepted") } catch (e) { if (e.code !== "BUDGET_EXHAUSTED") throw e; console.log("denied") } finally { ledger.close() }`
          const proc = Bun.spawn([process.execPath, '--no-env-file', '-e', code], {
            env: { PATH: process.env.PATH },
            stdout: 'pipe',
            stderr: 'pipe',
          })
          const [output, errors, exit] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ])
          expect(exit, errors).toBe(0)
          return output.trim()
        }),
      )
      expect(outcomes.filter((value) => value === 'accepted')).toHaveLength(1)
      expect(outcomes.filter((value) => value === 'denied')).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
