/**
 * Fixed-window rate limiting on Valkey (SEC-11, SEC-16). INCR and the window's expiry run in one Lua script, so a
 * crash between them cannot leave a counter without a TTL. Keys are namespaced by environment and never contain
 * personal data (callers pass IP groups and HMAC digests). If Valkey is unavailable the limiter fails CLOSED with
 * 503: an outage must not switch brute-force protection off. Lost counters only make limits more permissive for
 * one window, which is the accepted behaviour (docs/03 section 7).
 */
import { AppError } from '@chatapp/contracts'
import type { Valkey } from './valkey.ts'

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
  }

  async hit(policy: LimitPolicy, subject: string): Promise<LimitResult> {
    try {
      const reply = (await this.#valkey.eval(
        SCRIPT,
        1,
        `${this.#prefix}:${policy.name}:${subject}`,
        String(policy.windowMs),
      )) as [number, number]
      const [count, ttl] = reply
      return { allowed: count <= policy.limit, count, retryAfterMs: Math.max(ttl, 0) }
    } catch {
      throw new AppError('CAPACITY_UNAVAILABLE', 'Rate limiter is unavailable', {
        headers: { 'Retry-After': '5' },
      })
    }
  }

  /** Counts a hit against every policy/subject pair; throws 429 with Retry-After on the first that is exceeded. */
  async enforce(checks: ReadonlyArray<{ policy: LimitPolicy; subject: string }>): Promise<void> {
    let worst: LimitResult | undefined
    for (const { policy, subject } of checks) {
      const result = await this.hit(policy, subject)
      if (!result.allowed && (!worst || result.retryAfterMs > worst.retryAfterMs)) worst = result
    }
    if (worst) {
      throw new AppError('RATE_LIMITED', 'Too many requests', {
        headers: { 'Retry-After': String(Math.max(1, Math.ceil(worst.retryAfterMs / 1000))) },
      })
    }
  }
}
