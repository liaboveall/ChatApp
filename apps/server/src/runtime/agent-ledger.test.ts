import { expect, test } from 'bun:test'
import type { PaidCallLedger } from '../domain/ai-budget.ts'
import { trackedLedger } from './agent.ts'
import { ExperimentLedger } from './experiment-ledger.ts'

test('a rejected experiment reservation refunds domain admission without finalizing a nonexistent experiment call', async () => {
  const events: string[] = []
  const primary: PaidCallLedger = {
    reserve: () => {
      events.push('reserve')
    },
    release: () => {
      events.push('release')
    },
    start: () => {
      events.push('start')
    },
    settle: () => {
      events.push('settle')
    },
    unknown: () => {
      events.push('unknown')
    },
  }
  const experiment = new ExperimentLedger(':memory:', 0)
  const ids = new Set<string>()
  try {
    const ledger = trackedLedger(primary, experiment, ids)
    await expect(
      ledger.reserve({
        id: 'never-issued',
        label: 'admission',
        model: 'test',
        price: { version: 'paid-test', input: 1_000_000, cachedInput: 0, output: 1_000_000 },
        inputTokenBound: 1,
        maxOutputTokens: 1,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' })
    expect(events).toEqual(['reserve', 'release'])
    expect(ids.size).toBe(0)
    expect(experiment.snapshot().attempts).toBe(0)
  } finally {
    experiment.close()
  }
})
