import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AppError } from '@chatapp/contracts'
import { RateLimiter } from '../../src/lib/rate-limit.ts'
import { createValkey, type Valkey } from '../../src/lib/valkey.ts'
import { testConfig } from '../support/env.ts'

let valkey: Valkey
let limiter: RateLimiter
const runId = Math.random().toString(36).slice(2)

beforeAll(async () => {
  const config = testConfig()
  valkey = await createValkey(config.valkeyUrl, 'test-rate-limit')
  // Unique environment segment per run, so parallel or repeated runs never share counters.
  limiter = new RateLimiter(valkey, `test-${runId}`)
})
afterAll(async () => {
  const keys = await valkey.keys(`rl:test-${runId}:*`)
  if (keys.length > 0) await valkey.del(...keys)
  valkey.disconnect()
})

describe('RateLimiter', () => {
  test('allows up to the limit inside a window and then refuses with a retry hint', async () => {
    const policy = { name: 'unit.a', limit: 3, windowMs: 5_000 }
    const results = []
    for (let i = 0; i < 5; i += 1) results.push(await limiter.hit(policy, 'subject-1'))
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false])
    expect(results[4]?.count).toBe(5)
    expect(results[4]?.retryAfterMs).toBeGreaterThan(0)
    expect(results[4]?.retryAfterMs).toBeLessThanOrEqual(5_000)
  })

  test('subjects and policies are counted separately', async () => {
    const policy = { name: 'unit.b', limit: 1, windowMs: 5_000 }
    expect((await limiter.hit(policy, 'x')).allowed).toBe(true)
    expect((await limiter.hit(policy, 'y')).allowed).toBe(true)
    expect((await limiter.hit(policy, 'x')).allowed).toBe(false)
    expect((await limiter.hit({ ...policy, name: 'unit.b2' }, 'x')).allowed).toBe(true)
  })

  test('the window expires and counting starts over', async () => {
    const policy = { name: 'unit.c', limit: 1, windowMs: 200 }
    expect((await limiter.hit(policy, 's')).allowed).toBe(true)
    expect((await limiter.hit(policy, 's')).allowed).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect((await limiter.hit(policy, 's')).allowed).toBe(true)
  })

  test('every counter carries a TTL (a crash between increment and expire cannot leave an immortal key)', async () => {
    const policy = { name: 'unit.d', limit: 5, windowMs: 10_000 }
    await limiter.hit(policy, 'ttl')
    const ttl = await valkey.pttl(`rl:test-${runId}:unit.d:ttl`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(10_000)
  })

  test('concurrent hits are counted exactly', async () => {
    const policy = { name: 'unit.e', limit: 10, windowMs: 5_000 }
    const results = await Promise.all(
      Array.from({ length: 25 }, () => limiter.hit(policy, 'burst')),
    )
    expect(results.filter((r) => r.allowed)).toHaveLength(10)
  })

  test('enforce throws RATE_LIMITED with Retry-After for the worst offender', async () => {
    const tight = { name: 'unit.f', limit: 1, windowMs: 30_000 }
    const loose = { name: 'unit.g', limit: 100, windowMs: 30_000 }
    await limiter.enforce([
      { policy: tight, subject: 'z' },
      { policy: loose, subject: 'z' },
    ])
    let error: unknown
    try {
      await limiter.enforce([
        { policy: tight, subject: 'z' },
        { policy: loose, subject: 'z' },
      ])
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('RATE_LIMITED')
    expect(Number((error as AppError).headers?.['Retry-After'])).toBeGreaterThanOrEqual(1)
  })

  test('fails closed with 503 when Valkey is unreachable', async () => {
    const dead = await createValkey('redis://127.0.0.1:1/0', 'test-dead', { waitReady: false })
    const broken = new RateLimiter(dead, 'test-dead')
    let error: unknown
    try {
      await broken.hit({ name: 'unit.h', limit: 1, windowMs: 1000 }, 's')
    } catch (caught) {
      error = caught
    }
    dead.disconnect()
    expect((error as AppError).code).toBe('CAPACITY_UNAVAILABLE')
    expect((error as AppError).headers?.['Retry-After']).toBe('5')
  })
})
