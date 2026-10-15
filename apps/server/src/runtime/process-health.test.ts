import { describe, expect, test } from 'bun:test'
import { healthyWorker, workerHealthStatus } from './process-health.ts'

describe('worker event-loop health', () => {
  test('a stalled, future, malformed or foreign heartbeat fails closed', () => {
    const now = 100000
    const value = { format: 1, service: 'worker', pid: 7, updatedAt: now }
    expect(healthyWorker(value, now)).toBe(true)
    expect(healthyWorker(value, now + 35001)).toBe(false)
    expect(healthyWorker({ ...value, updatedAt: now + 5001 }, now)).toBe(false)
    expect(healthyWorker({ ...value, pid: 0 }, now)).toBe(false)
    expect(healthyWorker({ ...value, service: 'api' }, now)).toBe(false)
    expect(healthyWorker(null, now)).toBe(false)
    expect(workerHealthStatus(null, now)).toBe('invalid')
    expect(
      healthyWorker({ ...value, eventLoop: { samples: 10, p95Ms: 3, p99Ms: 4, maxMs: 5 } }, now),
    ).toBe(true)
    expect(
      healthyWorker({ ...value, eventLoop: { samples: 10, p95Ms: NaN, p99Ms: 4, maxMs: 5 } }, now),
    ).toBe(false)
    expect(workerHealthStatus(value, now + 35001)).toBe('stale')
    expect(workerHealthStatus({ ...value, updatedAt: now + 5001 }, now)).toBe('future')
  })
})
