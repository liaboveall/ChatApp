import { expect, test } from 'bun:test'
import { watchdogDecision } from './production-watchdog.ts'

const observed = {
  id: 'a'.repeat(64),
  running: true,
  health: 'unhealthy',
  project: 'chatapp-test',
  owner: 'test',
  release: 'b'.repeat(64),
  service: 'worker',
}
test('three spaced observations, healthy dependencies and a bounded restart budget are all required', () => {
  const first = watchdogDecision(undefined, observed, 100_000, true)
  const second = watchdogDecision(first.state, observed, 130_000, true)
  expect(first.restart).toBe(false)
  expect(second.restart).toBe(false)
  expect(watchdogDecision(second.state, observed, 160_000, true).restart).toBe(true)
  expect(watchdogDecision(second.state, observed, 160_000, false).restart).toBe(false)
  expect(
    watchdogDecision(
      { ...second.state, restarts: [130_000, 135_000, 140_000] },
      observed,
      160_000,
      true,
    ).restart,
  ).toBe(false)
  expect(
    watchdogDecision(second.state, { ...observed, id: 'c'.repeat(64) }, 160_000, true).restart,
  ).toBe(false)
  expect(watchdogDecision(second.state, observed, 132_000, true).restart).toBe(false)
  expect(
    watchdogDecision(second.state, { ...observed, health: 'healthy' }, 160_000, true).state
      .failures,
  ).toBe(0)
})
