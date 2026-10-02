import { describe, expect, test } from 'bun:test'
import {
  createClientIpResolver,
  isTrustedProxy,
  parseTrustedProxies,
  rateLimitIpKey,
} from './ip.ts'

describe('trusted proxies (SEC-28)', () => {
  test('parses single addresses and CIDR ranges', () => {
    expect(parseTrustedProxies('10.0.0.0/8, ::1 ,172.16.0.0/12')).toEqual({
      ok: ['10.0.0.0/8', '::1', '172.16.0.0/12'],
      invalid: [],
    })
    expect(parseTrustedProxies('10.0.0.0/33').invalid).toEqual(['10.0.0.0/33'])
    expect(parseTrustedProxies('10.0.0.0/8/1').invalid).toEqual(['10.0.0.0/8/1'])
    expect(parseTrustedProxies('not-an-ip').invalid).toEqual(['not-an-ip'])
  })

  test('matches addresses, ranges and IPv4-mapped IPv6 peers', () => {
    const trusted = ['127.0.0.1', '::1', '10.0.0.0/8']
    expect(isTrustedProxy('127.0.0.1', trusted)).toBe(true)
    expect(isTrustedProxy('::ffff:127.0.0.1', trusted)).toBe(true)
    expect(isTrustedProxy('::1', trusted)).toBe(true)
    expect(isTrustedProxy('10.20.30.40', trusted)).toBe(true)
    expect(isTrustedProxy('11.0.0.1', trusted)).toBe(false)
    expect(isTrustedProxy('203.0.113.9', trusted)).toBe(false)
    expect(isTrustedProxy('not-an-ip', trusted)).toBe(false)
  })
})

describe('client IP resolution', () => {
  const resolve = createClientIpResolver(['127.0.0.1', '::1', '10.0.0.0/8'])

  test('ignores forwarded headers from an untrusted peer', () => {
    expect(resolve('203.0.113.9', '1.2.3.4', '5.6.7.8')).toBe('203.0.113.9')
  })

  test('takes the first untrusted hop from the right of X-Forwarded-For', () => {
    expect(resolve('127.0.0.1', '9.9.9.9, 203.0.113.7', null)).toBe('203.0.113.7')
    // A client-supplied prefix cannot override what the proxy appended.
    expect(resolve('127.0.0.1', '6.6.6.6, 203.0.113.7, 10.1.1.1', null)).toBe('203.0.113.7')
  })

  test('falls back to X-Real-IP, then to the proxy itself', () => {
    expect(resolve('127.0.0.1', null, '198.51.100.4')).toBe('198.51.100.4')
    expect(resolve('127.0.0.1', null, null)).toBe('127.0.0.1')
    expect(resolve('127.0.0.1', '10.2.2.2', null)).toBe('127.0.0.1')
  })

  test('does not guess on malformed chains', () => {
    // Only the part the trusted proxy appended (the right end) matters.
    expect(resolve('127.0.0.1', 'garbage, 203.0.113.7', null)).toBe('203.0.113.7')
    expect(resolve('127.0.0.1', '203.0.113.7, garbage', null)).toBe('127.0.0.1')
  })

  test('normalizes mapped IPv4 peers and handles a missing peer', () => {
    expect(resolve('::ffff:203.0.113.9', null, null)).toBe('203.0.113.9')
    expect(resolve(undefined, null, null)).toBe('unknown')
  })
})

describe('rate limit keys', () => {
  test('IPv4 is used as is, IPv6 is grouped by /64', () => {
    expect(rateLimitIpKey('203.0.113.9')).toBe('203.0.113.9')
    expect(rateLimitIpKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:0db8:0001:0002::/64')
    expect(rateLimitIpKey('2001:db8:1:2::1')).toBe('2001:0db8:0001:0002::/64')
    expect(rateLimitIpKey('::1')).toBe('0000:0000:0000:0000::/64')
  })
})
