import { describe, expect, test } from 'vitest'
import { describeUserAgent, deviceTitle } from './user-agent.ts'

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36',
}

describe('describeUserAgent', () => {
  test.each([
    [UA.chromeWindows, 'Chrome', 'Windows', 'desktop'],
    [UA.edge, 'Edge', 'Windows', 'desktop'],
    [UA.safariMac, 'Safari', 'macOS', 'desktop'],
    [UA.firefoxLinux, 'Firefox', 'Linux', 'desktop'],
    [UA.safariIphone, 'Safari', 'iOS', 'phone'],
    [UA.chromeAndroid, 'Chrome', 'Android', 'phone'],
  ])('%s', (ua, browser, os, kind) => {
    expect(describeUserAgent(ua)).toEqual({ browser, os, kind })
  })

  test('no user agent, or one we do not know, still gives something displayable', () => {
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null, kind: 'desktop' })
    expect(deviceTitle(describeUserAgent(null), 'Unknown device')).toBe('Unknown device')
    expect(deviceTitle(describeUserAgent('curl/8.0'), 'Unknown device')).toBe('Unknown device')
    expect(deviceTitle(describeUserAgent(UA.edge), 'x')).toBe('Edge · Windows')
  })
})
