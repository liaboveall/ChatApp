import { describe, expect, test } from 'bun:test'
import { developmentSite } from './dev-site.ts'
import type { WindowsPorts } from './ports.ts'

const windows: WindowsPorts = {
  excluded: [{ start: 5155, end: 5254 }],
  dynamic: { start: 1024, end: 15000 },
}

describe('development localhost forwarding', () => {
  test('keeps the normal development and PWA origins when no Windows reservation applies', () => {
    expect(developmentSite('web', null).origin).toBe('http://localhost:5173')
    expect(developmentSite('pwa', null).origin).toBe('http://localhost:25173')
    expect(developmentSite('pwa', windows).origin).toBe('http://localhost:25173')
  })

  test('moves the blocked HMR port outside the dynamic range without taking the PWA origin', () => {
    const site = developmentSite('web', windows)
    expect(site.reservation).toEqual({ start: 5155, end: 5254 })
    expect(site.origin).toBe('http://localhost:25174')
  })

  test('also avoids explicit reservations above the dynamic range', () => {
    const ranges = [...windows.excluded, { start: 25173, end: 25180 }]
    expect(developmentSite('web', { ...windows, excluded: ranges }).port).toBe(25182)
    expect(developmentSite('pwa', { ...windows, excluded: ranges }).port).toBe(25181)
  })
})
