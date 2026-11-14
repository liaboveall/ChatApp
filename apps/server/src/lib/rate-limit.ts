/**
 * Fixed-window rate limiting on Valkey (SEC-11, SEC-16). INCR and the window's expiry run in one Lua script, so a
 * crash between them cannot leave a counter without a TTL. Keys are namespaced by environment and never contain
 * personal data (callers pass IP groups and HMAC digests). If Valkey is unavailable the limiter fails CLOSED with
 * 503: an outage must not switch brute-force protection off. Lost counters only make limits more permissive for
 * one window, which is the accepted behaviour (docs/03 section 7).
 */
import { AppError } from '@chatapp/contracts'
import type { Result } from 'ioredis'
import type { Valkey } from './valkey.ts'

declare module 'ioredis' {
  interface RedisCommander<Context> {
    /** The window counter: INCR with its expiry, as one script (registered by `RateLimiter`). */
    chatappRateLimitHit(key: string, windowMs: string): Result<[number, number], Context>
  }
}

export type LimitPolicy = {
  /** Short name used in the key and in logs, for example `login.ip`. */
  name: string
  limit: number
  windowMs: number
}

export type LimitResult = { allowed: boolean; count: number; retryAfterMs: number }

const SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if current == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`

export class RateLimiter {
  readonly #valkey: Valkey
  readonly #prefix: string

  constructor(valkey: Valkey, environment: string) {
    this.#valkey = valkey
    this.#prefix = `rl:${environment}`
    // Registered once per client: the script travels as its hash (EVALSHA) from then on, not as text on every hit.
    if (typeof valkey.chatappRateLimitHit !== 'function')
      valkey.defineCommand('chatappRateLimitHit', { numberOfKeys: 1, lua: SCRIPT })
  }

  async hit(policy: LimitPolicy, subject: string): Promise<LimitResult> {
    try {
      const [count, ttl] = await this.#valkey.chatappRateLimitHit(
        `${this.#prefix}:${policy.name}:${subject}`,
        String(policy.windowMs),
      )
      return { allowed: count <= policy.limit, count, retryAfterMs: Math.max(ttl, 0) }
    } catch {
      throw new AppError('CAPACITY_UNAVAILABLE', 'Rate limiter is unavailable', {
        headers: { 'Retry-After': '5' },
      })
    }
  }

  /**
   * Counts a hit against every policy/subject pair and throws 429 when any is exceeded, with the longest Retry-After of
   * those that were. The hits go out together and are answered in one round trip; every pair is counted either way.
   */
  async enforce(checks: ReadonlyArray<{ policy: LimitPolicy; subject: string }>): Promise<void> {
    const results = await Promise.all(
      checks.map(({ policy, subject }) => this.hit(policy, subject)),
    )
    let worst: LimitResult | undefined
    for (const result of results) {
      if (!result.allowed && (!worst || result.retryAfterMs > worst.retryAfterMs)) worst = result
    }
    if (worst) {
      throw new AppError('RATE_LIMITED', 'Too many requests', {
        headers: { 'Retry-After': String(Math.max(1, Math.ceil(worst.retryAfterMs / 1000))) },
      })
    }
  }
}
