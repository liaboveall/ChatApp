/**
 * Where a push may be sent (SEC-23, D-065, AT-11). The endpoint of a subscription is an address the *browser* handed to
 * us, so it is untrusted input that the server will later request: it has to be a known push service, reached over HTTPS
 * on port 443, and every address its name resolves to has to be a public one. The check runs when the subscription is
 * registered and again on every send; the connection is then pinned to an address that passed (`push-transport.ts`), so
 * a name that answers differently the second time cannot redirect the request inside the network.
 *
 * The list of services is the four whose endpoints browsers hand out today. It grows only with real subscription evidence
 * (V-10): a vendor name alone never adds a host (D-065).
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export type EndpointRejection =
  | 'not_a_url'
  | 'too_long'
  | 'not_https'
  | 'credentials'
  | 'port'
  | 'fragment'
  | 'ip_literal'
  | 'host_not_allowed'
  | 'bad_path'

export type EndpointVerdict =
  | { ok: true; url: URL; hostname: string; provider: string }
  | { ok: false; reason: EndpointRejection }

export class EndpointError extends Error {
  constructor(readonly reason: EndpointRejection | 'dns_failed' | 'non_public_address') {
    super(reason)
    this.name = 'EndpointError'
  }
}

export type ProviderRule = {
  provider: string
  /** Hostnames matched exactly. */
  exact?: readonly string[]
  /** Domain suffixes (with the leading dot); the bare domain itself does not match. */
  suffix?: readonly string[]
}

/**
 * - fcm: Chrome and the Chromium browsers (Edge outside Windows, Opera, Brave, Samsung Internet).
 * - mozilla: Firefox.
 * - apple: Safari on macOS 13 and later and on iOS and iPadOS 16.4 and later.
 * - wns: Edge on Windows.
 */
export const PUSH_PROVIDERS: readonly ProviderRule[] = [
  { provider: 'fcm', exact: ['fcm.googleapis.com'] },
  { provider: 'mozilla', exact: ['updates.push.services.mozilla.com'] },
  { provider: 'apple', exact: ['web.push.apple.com'] },
  { provider: 'wns', suffix: ['.notify.windows.com'] },
]

const MAX_ENDPOINT_LENGTH = 2048
/** Visible ASCII only: nothing that could end a request line or start another header. */
const SAFE_PATH = /^\/[\x21-\x7e]*$/

function providerOf(hostname: string, rules: readonly ProviderRule[]): string | null {
  for (const rule of rules) {
    if (rule.exact?.includes(hostname)) return rule.provider
    for (const suffix of rule.suffix ?? []) {
      if (hostname.length > suffix.length && hostname.endsWith(suffix)) return rule.provider
    }
  }
  return null
}

/** The syntax and allow-list part of the check; it makes no network request. */
export function checkEndpoint(
  endpoint: string,
  rules: readonly ProviderRule[] = PUSH_PROVIDERS,
): EndpointVerdict {
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return { ok: false, reason: 'too_long' }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { ok: false, reason: 'not_a_url' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  // `URL` drops the default port, so anything left is another port.
  if (url.port !== '') return { ok: false, reason: 'port' }
  if (url.hash !== '') return { ok: false, reason: 'fragment' }
  // A trailing dot names the same host but would slip past a suffix comparison; browsers never produce one.
  const hostname = url.hostname.toLowerCase()
  if (isIP(hostname) !== 0 || hostname.startsWith('[') || /^[\d.]+$/.test(hostname)) {
    return { ok: false, reason: 'ip_literal' }
  }
  const provider = providerOf(hostname, rules)
  if (provider === null) return { ok: false, reason: 'host_not_allowed' }
  if (!SAFE_PATH.test(`${url.pathname}${url.search}`)) return { ok: false, reason: 'bad_path' }
  return { ok: true, url, hostname, provider }
}

// ───────── public addresses ─────────

function parseIPv4(text: string): number | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

/** The 128 bits of an IPv6 address, or null when the text is not one (zone identifiers are refused as well). */
function parseIPv6(text: string): bigint | null {
  if (text.includes('%') || text.length > 45) return null
  let head = text
  let tail4: number | null = null
  const lastColon = text.lastIndexOf(':')
  if (lastColon !== -1 && text.includes('.', lastColon)) {
    tail4 = parseIPv4(text.slice(lastColon + 1))
    if (tail4 === null) return null
    head = `${text.slice(0, lastColon + 1)}0:0`
  }
  const halves = head.split('::')
  if (halves.length > 2) return null
  const groups = (part: string): string[] | null => {
    if (part === '') return []
    const list = part.split(':')
    return list.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)) ? list : null
  }
  const left = groups(halves[0] ?? '')
  const right = halves.length === 2 ? groups(halves[1] ?? '') : []
  if (left === null || right === null) return null
  const missing = 8 - left.length - right.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const all = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right]
  if (all.length !== 8) return null
  let value = 0n
  for (const group of all) value = (value << 16n) | BigInt(Number.parseInt(group, 16))
  if (tail4 !== null) value = (value & ~0xffffffffn) | BigInt(tail4)
  return value
}

/** Special-purpose IPv4 blocks (IANA registry, RFC 6890 and later): [first address, prefix length]. */
const IPV4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]
const IPV4_BLOCKS = IPV4_BLOCKED.map(([base, prefix]) => {
  const first = parseIPv4(base) ?? 0
  const size = 2 ** (32 - prefix)
  return [first, first + size - 1] as const
})

/** Global unicast is 2000::/3; inside it the documentation, protocol-assignment and 6to4 blocks are still not public hosts. */
const IPV6_BLOCKED: ReadonlyArray<readonly [bigint, number]> = [
  [0x2001_0000_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_0db8_0000_0000_0000_0000_0000_0000n, 32],
  [0x2002_0000_0000_0000_0000_0000_0000_0000n, 16],
  [0x3fff_0000_0000_0000_0000_0000_0000_0000n, 20],
]
const inBlock6 = (address: bigint, base: bigint, prefix: number): boolean =>
  address >> BigInt(128 - prefix) === base >> BigInt(128 - prefix)

/**
 * Whether an address as text (an answer of the resolver) is a public Internet host. IPv4 is judged by what is *not*
 * public; IPv6 by what is: only global unicast qualifies, which also removes loopback, link-local, unique-local,
 * IPv4-mapped (`::ffff:127.0.0.1`), NAT64 and multicast without listing them. Anything that does not parse is not public.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const value = parseIPv4(address)
    if (value === null) return false
    return !IPV4_BLOCKS.some(([first, last]) => value >= first && value <= last)
  }
  if (family === 6) {
    const value = parseIPv6(address)
    if (value === null) return false
    if (!inBlock6(value, 0x2000_0000_0000_0000_0000_0000_0000_0000n, 3)) return false
    return !IPV6_BLOCKED.some(([base, prefix]) => inBlock6(value, base, prefix))
  }
  return false
}

// ───────── resolution ─────────

export type Resolved = { address: string; family: 4 | 6 }
export type Lookup = (hostname: string) => Promise<Resolved[]>

export type EndpointPolicy = {
  /** Syntax and allow-list only. */
  check(endpoint: string): EndpointVerdict
  /** Every address of the name, all of them checked; throws `EndpointError` unless there is at least one and all are public. */
  resolve(hostname: string): Promise<Resolved[]>
}

export function createEndpointPolicy(
  options: {
    rules?: readonly ProviderRule[]
    lookup?: Lookup
    isPublic?: (address: string) => boolean
  } = {},
): EndpointPolicy {
  const rules = options.rules ?? PUSH_PROVIDERS
  const isPublic = options.isPublic ?? isPublicAddress
  const lookup: Lookup =
    options.lookup ??
    (async (hostname) => {
      // `verbatim`: keep the resolver's order; `all`: every A and AAAA answer, not only the first.
      const answers = await dnsLookup(hostname, { all: true, verbatim: true })
      return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
    })
  return {
    check: (endpoint) => checkEndpoint(endpoint, rules),
    async resolve(hostname) {
      let answers: Resolved[]
      try {
        answers = await lookup(hostname)
      } catch {
        throw new EndpointError('dns_failed')
      }
      if (answers.length === 0) throw new EndpointError('dns_failed')
      // One private answer among public ones is enough to refuse: the connection could be sent to either (DNS rebinding).
      if (!answers.every((a) => isPublic(a.address))) throw new EndpointError('non_public_address')
      return answers
    },
  }
}
