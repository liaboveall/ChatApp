import { describe, expect, test } from 'bun:test'
import {
  checkEndpoint,
  createEndpointPolicy,
  EndpointError,
  isPublicAddress,
  PUSH_PROVIDERS,
} from './push-endpoints.ts'

describe('which endpoints are accepted (SEC-23)', () => {
  const accepted: Array<[string, string]> = [
    ['https://fcm.googleapis.com/fcm/send/dXNlcg:APA91bH', 'fcm'],
    ['https://fcm.googleapis.com/wp/dXNlcg:APA91bH', 'fcm'],
    ['https://updates.push.services.mozilla.com/wpush/v2/gAAAA', 'mozilla'],
    ['https://web.push.apple.com/QG4mXk', 'apple'],
    ['https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB', 'wns'],
    ['https://sg2p.notify.windows.com/w/?token=x', 'wns'],
    ['HTTPS://FCM.GOOGLEAPIS.COM/fcm/send/x', 'fcm'],
  ]
  for (const [endpoint, provider] of accepted) {
    test(`accepts ${endpoint}`, () => {
      const verdict = checkEndpoint(endpoint)
      expect(verdict.ok).toBe(true)
      if (verdict.ok) expect(verdict.provider).toBe(provider)
    })
  }

  const refused: Array<[string, string]> = [
    ['http://fcm.googleapis.com/fcm/send/x', 'not_https'],
    ['ftp://fcm.googleapis.com/x', 'not_https'],
    ['file:///etc/passwd', 'not_https'],
    ['javascript:alert(1)', 'not_https'],
    ['//fcm.googleapis.com/x', 'not_a_url'],
    ['', 'not_a_url'],
    ['https://', 'not_a_url'],
    ['https://user@fcm.googleapis.com/x', 'credentials'],
    ['https://user:secret@fcm.googleapis.com/x', 'credentials'],
    ['https://fcm.googleapis.com@evil.example/x', 'credentials'],
    ['https://fcm.googleapis.com:444/x', 'port'],
    ['https://fcm.googleapis.com:8443/x', 'port'],
    ['https://fcm.googleapis.com/x#a', 'fragment'],
    // IP literals in every spelling the URL parser knows
    ['https://127.0.0.1/x', 'ip_literal'],
    ['https://2130706433/x', 'ip_literal'],
    ['https://0x7f.0.0.1/x', 'ip_literal'],
    ['https://0177.0.0.1/x', 'ip_literal'],
    ['https://127.1/x', 'ip_literal'],
    ['https://169.254.169.254/latest/meta-data', 'ip_literal'],
    ['https://[::1]/x', 'ip_literal'],
    ['https://[::ffff:127.0.0.1]/x', 'ip_literal'],
    ['https://[fd00:ec2::254]/x', 'ip_literal'],
    // names that are not on the list, including look-alikes
    ['https://localhost/x', 'host_not_allowed'],
    ['https://metadata.google.internal/computeMetadata/v1/', 'host_not_allowed'],
    ['https://fcm.googleapis.com.evil.example/x', 'host_not_allowed'],
    ['https://evil-fcm.googleapis.com/x', 'host_not_allowed'],
    ['https://googleapis.com/x', 'host_not_allowed'],
    ['https://notify.windows.com/x', 'host_not_allowed'],
    ['https://evilnotify.windows.com/x', 'host_not_allowed'],
    ['https://windows.com/x', 'host_not_allowed'],
    ['https://push.apple.com/x', 'host_not_allowed'],
    ['https://api.push.apple.com/x', 'host_not_allowed'],
    ['https://mozilla.com/x', 'host_not_allowed'],
    ['https://fcm.googleapis.com./x', 'host_not_allowed'],
    ['https://x.notify.windows.com./x', 'host_not_allowed'],
  ]
  for (const [endpoint, reason] of refused) {
    test(`refuses ${endpoint || '(empty)'} as ${reason}`, () => {
      const verdict = checkEndpoint(endpoint)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) expect(verdict.reason).toBe(reason as typeof verdict.reason)
    })
  }

  test('confusing separators change nothing: what is connected to is the host the parser reports', () => {
    // A backslash is a path separator for https URLs, so this is fcm.googleapis.com with a strange path, not evil.example.
    const verdict = checkEndpoint('https://fcm.googleapis.com\\@evil.example/x')
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.hostname).toBe('fcm.googleapis.com')
      expect(verdict.url.pathname).toBe('/@evil.example/x')
    }
    // And the other way round: the real host is the one after the @ and it is not on the list.
    expect(checkEndpoint('https://fcm.googleapis.com@evil.example/x').ok).toBe(false)
    expect(checkEndpoint('https://evil.example\\@fcm.googleapis.com/x').ok).toBe(false)
  })

  test('refuses a path that could end the request line', () => {
    // The URL parser percent-encodes spaces and line breaks, so what is left must be visible ASCII.
    const verdict = checkEndpoint('https://fcm.googleapis.com/x y\r\nHost: evil')
    if (verdict.ok) expect(verdict.url.pathname).not.toMatch(/[\r\n ]/)
  })

  test('is bounded in length', () => {
    expect(checkEndpoint(`https://fcm.googleapis.com/${'a'.repeat(2100)}`)).toEqual({
      ok: false,
      reason: 'too_long',
    })
  })

  test('the list is exactly the four services whose endpoints browsers hand out (D-065)', () => {
    expect(PUSH_PROVIDERS.map((rule) => rule.provider)).toEqual(['fcm', 'mozilla', 'apple', 'wns'])
  })
})

describe('public addresses', () => {
  const publicOnes = [
    '142.250.80.74', // a Google address
    '17.253.144.10', // Apple
    '40.97.0.1', // Microsoft
    '34.107.243.93',
    '1.1.1.1',
    '8.8.8.8',
    '100.63.255.255', // just below the shared address space
    '100.128.0.0', // just above it
    '172.15.255.255',
    '172.32.0.0',
    '192.167.255.255',
    '223.255.255.255',
    '2404:6800:4003:c01::5f', // Google
    '2607:f8b0:4005:80a::200e',
    '2620:149:a44:1000::1', // Apple
    '2603:1026:3000::1', // Microsoft
    '2a00:1450:4001::1',
    '2001:4860:4860::8888',
  ]
  for (const address of publicOnes) {
    test(`${address} is public`, () => expect(isPublicAddress(address)).toBe(true))
  }

  const notPublic = [
    // this network, private, shared, loopback, link-local (and the cloud metadata address)
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '100.100.100.200', // Alibaba Cloud metadata
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.0.192', // Oracle Cloud metadata
    '192.0.2.1',
    '192.88.99.1',
    '192.168.0.1',
    '192.168.255.255',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    // IPv6: unspecified, loopback, mapped, NAT64, unique-local, link-local, multicast, documentation, 6to4, Teredo
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:8.8.8.8',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::808:808',
    'fc00::1',
    'fd00:ec2::254', // AWS IPv6 metadata
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '2001:db8::1',
    '2001:db8:ffff::1',
    '2002:7f00:1::1',
    '2002:808:808::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '3fff::1',
    '100::1',
    '5f00::1',
    // not addresses at all
    '',
    'localhost',
    'fcm.googleapis.com',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '01.2.3.4',
    '1.2.3.04',
    '0x7f.0.0.1',
    '2130706433',
    '::g',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    '[::1]',
  ]
  for (const address of notPublic) {
    test(`${JSON.stringify(address)} is not public`, () =>
      expect(isPublicAddress(address)).toBe(false))
  }
})

describe('resolution (DNS rebinding)', () => {
  const policy = (answers: Array<{ address: string; family: 4 | 6 }> | Error) =>
    createEndpointPolicy({
      lookup: async () => {
        if (answers instanceof Error) throw answers
        return answers
      },
    })

  test('all answers public: fine', async () => {
    const answers = [
      { address: '142.250.80.74', family: 4 as const },
      { address: '2607:f8b0:4005:80a::200e', family: 6 as const },
    ]
    await expect(policy(answers).resolve('fcm.googleapis.com')).resolves.toEqual(answers)
  })

  test('one private answer among public ones refuses the name', async () => {
    const mixed = policy([
      { address: '142.250.80.74', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(mixed.resolve('fcm.googleapis.com')).rejects.toMatchObject({
      reason: 'non_public_address',
    })
  })

  test('an answer that is a mapped IPv4 loopback, metadata or private address is refused', async () => {
    for (const address of ['::ffff:127.0.0.1', '169.254.169.254', '10.1.2.3', 'fd00::1']) {
      const family = address.includes(':') ? 6 : 4
      await expect(
        policy([{ address, family }]).resolve('fcm.googleapis.com'),
      ).rejects.toBeInstanceOf(EndpointError)
    }
  })

  test('no answer, or a resolver that fails: dns_failed', async () => {
    await expect(policy([]).resolve('fcm.googleapis.com')).rejects.toMatchObject({
      reason: 'dns_failed',
    })
    await expect(policy(new Error('SERVFAIL')).resolve('fcm.googleapis.com')).rejects.toMatchObject(
      {
        reason: 'dns_failed',
      },
    )
  })

  test('every call asks again: a name that changes its answer is caught the second time', async () => {
    let calls = 0
    const rebinding = createEndpointPolicy({
      lookup: async () => {
        calls += 1
        return calls === 1
          ? [{ address: '142.250.80.74', family: 4 as const }]
          : [{ address: '10.0.0.5', family: 4 as const }]
      },
    })
    await expect(rebinding.resolve('fcm.googleapis.com')).resolves.toHaveLength(1)
    await expect(rebinding.resolve('fcm.googleapis.com')).rejects.toMatchObject({
      reason: 'non_public_address',
    })
  })
})
