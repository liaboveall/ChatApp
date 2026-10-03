import { describe, expect, test } from 'bun:test'
import { ManualClock } from '../lib/clock.ts'
import { fingerprint, signPayload, verifyPayload } from '../lib/crypto.ts'
import { cursorExpiry, decodeCursor, encodeCursor, type UserCursor } from './cursor.ts'
import type { Deps } from './deps.ts'

const key = new Uint8Array(32).fill(7)
const otherKey = new Uint8Array(32).fill(9)

function deps(
  clock = new ManualClock(1_000_000),
): Pick<Deps, 'config' | 'clock'> & { clock: ManualClock } {
  return { clock, config: { auth: { cursorKey: key } } as Deps['config'] }
}

const cursor = (d: ReturnType<typeof deps>, userId = 'u1'): UserCursor => ({
  k: 'uc',
  u: userId,
  ae: 0,
  re: 'r',
  a: 5,
  t: 20,
  x: cursorExpiry(d),
})

describe('signed payloads', () => {
  test('round-trip, and refuse tampering, another key and malformed tokens', () => {
    const token = signPayload(key, { a: 1, nested: { b: 'two' } })
    expect(verifyPayload(key, token)).toEqual({ a: 1, nested: { b: 'two' } })
    expect(verifyPayload(otherKey, token)).toBeNull()
    const [body = '', mac = ''] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ a: 2 })).toString('base64url')
    expect(verifyPayload(key, `${forged}.${mac}`)).toBeNull()
    expect(verifyPayload(key, `${body}.${mac.slice(1)}x`)).toBeNull()
    for (const bad of ['', 'abc', 'a.b.c', '.', `${body}.`, `.${mac}`]) {
      expect(verifyPayload(key, bad)).toBeNull()
    }
  })

  test('a fingerprint ignores key order and undefined fields but not values', () => {
    expect(fingerprint({ a: 1, b: [1, { y: 2, x: 1 }] })).toBe(
      fingerprint({ b: [1, { x: 1, y: 2 }], a: 1, ignored: undefined }),
    )
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
    expect(fingerprint({ a: [1, 2] })).not.toBe(fingerprint({ a: [2, 1] }))
  })
})

describe('cursors', () => {
  test('are accepted only for the person they were issued to, of the same kind, before they expire', () => {
    const d = deps()
    const token = encodeCursor(d, cursor(d))
    expect(decodeCursor(d, token, 'uc', { userId: 'u1' })).toMatchObject({ a: 5, t: 20 })
    expect(decodeCursor(d, token, 'uc', { userId: 'u2' })).toBeNull()
    expect(decodeCursor(d, token, 'cc', { userId: 'u1' })).toBeNull()
    d.clock.advance(10 * 60 * 1000 - 1)
    expect(decodeCursor(d, token, 'uc', { userId: 'u1' })).not.toBeNull()
    d.clock.advance(2)
    expect(decodeCursor(d, token, 'uc', { userId: 'u1' })).toBeNull()
  })

  test('a cursor signed under another key is refused', () => {
    const d = deps()
    const foreign = signPayload(otherKey, cursor(d))
    expect(decodeCursor(d, foreign, 'uc', { userId: 'u1' })).toBeNull()
  })
})
