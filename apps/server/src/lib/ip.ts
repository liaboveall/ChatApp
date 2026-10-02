/**
 * Client IP resolution (SEC-28). Forwarded headers are only believed when the connecting peer is one of the
 * configured trusted proxies; the client address is the first address, scanning X-Forwarded-For from the right,
 * that is not itself a trusted proxy. Anything else from the network is ignored.
 */
import { BlockList, isIP } from 'node:net'

export function parseTrustedProxies(list: string): { ok: string[]; invalid: string[] } {
  const ok: string[] = []
  const invalid: string[] = []
  for (const entry of list
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [address, prefix, ...rest] = entry.split('/')
    const family = address === undefined ? 0 : isIP(address)
    const max = family === 4 ? 32 : 128
    const prefixOk =
      prefix === undefined ||
      (/^\d{1,3}$/.test(prefix) && Number(prefix) >= 0 && Number(prefix) <= max)
    if (family === 0 || rest.length > 0 || !prefixOk) invalid.push(entry)
    else ok.push(entry)
  }
  return { ok, invalid }
}

/** IPv4-mapped IPv6 peers (::ffff:1.2.3.4) are treated as the IPv4 address. */
export function normalizeIp(address: string): string {
  const lower = address.trim().toLowerCase()
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4 ? lower.slice(7) : lower
}

/** Compiles the trusted-proxy entries (single IPs or CIDR ranges) into a matcher; build it once, not per request. */
export function createTrustedMatcher(trusted: readonly string[]): (address: string) => boolean {
  const list = new BlockList()
  for (const entry of trusted) {
    const [base, prefix] = entry.split('/')
    if (base === undefined) continue
    const type = isIP(base) === 6 ? 'ipv6' : 'ipv4'
    if (prefix === undefined) list.addAddress(base, type)
    else list.addSubnet(base, Number(prefix), type)
  }
  return (address) => {
    const normalized = normalizeIp(address)
    const family = isIP(normalized)
    return family !== 0 && list.check(normalized, family === 6 ? 'ipv6' : 'ipv4')
  }
}

export function isTrustedProxy(address: string, trusted: readonly string[]): boolean {
  return createTrustedMatcher(trusted)(address)
}

export function createClientIpResolver(trusted: readonly string[]) {
  const trustedPeer = createTrustedMatcher(trusted)

  return (peer: string | undefined, forwardedFor: string | null, realIp: string | null): string => {
    if (peer === undefined) return 'unknown'
    const peerIp = normalizeIp(peer)
    if (isIP(peerIp) === 0) return 'unknown'
    if (!trustedPeer(peerIp)) return peerIp

    const chain = (forwardedFor ?? '')
      .split(',')
      .map((item) => normalizeIp(item))
      .filter((item) => item !== '')
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const hop = chain[index]
      if (hop === undefined || isIP(hop) === 0) return peerIp // malformed chain: do not guess
      if (!trustedPeer(hop)) return hop
    }
    const real = realIp === null ? undefined : normalizeIp(realIp)
    if (real !== undefined && isIP(real) !== 0 && !trustedPeer(real)) return real
    return peerIp
  }
}

/** Rate limiting groups IPv6 clients by /64 so one host cannot rotate through its whole prefix. */
export function rateLimitIpKey(ip: string): string {
  if (isIP(ip) !== 6) return ip
  const groups = expandIpv6(ip)
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip
}

function expandIpv6(ip: string): string[] | undefined {
  const [head = '', tail = ''] = ip.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === '' ? [] : tail.split(':')
  const missing = ip.includes('::') ? 8 - left.length - right.length : 0
  const all = [...left, ...Array.from({ length: Math.max(missing, 0) }, () => '0'), ...right]
  if (all.length !== 8) return undefined
  return all.map((group) => group.padStart(4, '0'))
}
