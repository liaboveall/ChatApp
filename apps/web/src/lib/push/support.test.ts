import { describe, expect, test } from 'vitest'
import { type Environment, keyBytes, sameKey, supportFor } from './support.ts'

const ok: Environment = {
  secure: true,
  hasServiceWorker: true,
  hasPush: true,
  hasNotifications: true,
  appleTouch: false,
  standalone: false,
  storage: true,
}

describe('whether this browser can receive a push', () => {
  test('a secure page with everything is supported', () => {
    expect(supportFor(ok)).toEqual({ supported: true })
  })

  test('each missing piece is named', () => {
    expect(supportFor({ ...ok, secure: false })).toEqual({ supported: false, reason: 'insecure' })
    expect(supportFor({ ...ok, hasServiceWorker: false })).toEqual({
      supported: false,
      reason: 'no-service-worker',
    })
    expect(supportFor({ ...ok, hasPush: false })).toEqual({ supported: false, reason: 'no-push' })
    expect(supportFor({ ...ok, hasNotifications: false })).toEqual({
      supported: false,
      reason: 'no-notifications',
    })
    expect(supportFor({ ...ok, storage: false })).toEqual({
      supported: false,
      reason: 'no-storage',
    })
  })

  test('on an iPhone or iPad it only works as an installed app, and says so', () => {
    expect(supportFor({ ...ok, appleTouch: true })).toEqual({
      supported: false,
      reason: 'needs-install',
    })
    expect(supportFor({ ...ok, appleTouch: true, standalone: true })).toEqual({ supported: true })
  })
})

describe('the application server key', () => {
  test('base64url becomes bytes, with or without padding', () => {
    // 65 bytes of a P-256 point start with 0x04.
    const point = Uint8Array.from([4, ...Array.from({ length: 64 }, (_, i) => (i * 7) % 256)])
    const base64url = btoa(String.fromCharCode(...point))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    expect(Array.from(keyBytes(base64url))).toEqual(Array.from(point))
    expect(keyBytes('AQID').length).toBe(3)
  })

  test('two keys are the same when every byte is', () => {
    const key = Uint8Array.from([1, 2, 3])
    expect(sameKey(key.buffer, key)).toBe(true)
    expect(sameKey(Uint8Array.from([1, 2, 4]).buffer, key)).toBe(false)
    expect(sameKey(Uint8Array.from([1, 2]).buffer, key)).toBe(false)
    expect(sameKey(null, key)).toBe(false)
  })
})
