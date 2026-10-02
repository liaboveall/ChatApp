/**
 * A short, human name for a device from its User-Agent ("Chrome · Windows"). Only coarse families are recognized: the
 * string is shown to its owner to tell their own logins apart (docs/01 section 4.11), not for analytics.
 */

export type DeviceKind = 'desktop' | 'phone'

export type DeviceName = { browser: string | null; os: string | null; kind: DeviceKind }

export function describeUserAgent(userAgent: string | null): DeviceName {
  if (!userAgent) return { browser: null, os: null, kind: 'desktop' }
  const ua = userAgent
  // Order matters: Edge and Opera say "Chrome", Chrome says "Safari".
  let browser: string | null = null
  if (/Edg(e|A|iOS)?\//.test(ua)) browser = 'Edge'
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera'
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox'
  else if (/Chrome\/|CriOS\//.test(ua)) browser = 'Chrome'
  else if (/Safari\//.test(ua)) browser = 'Safari'

  let os: string | null = null
  if (/Windows/.test(ua)) os = 'Windows'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS'
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS'
  else if (/CrOS/.test(ua)) os = 'ChromeOS'
  else if (/Linux|X11/.test(ua)) os = 'Linux'

  const kind: DeviceKind = os === 'Android' || os === 'iOS' ? 'phone' : 'desktop'
  return { browser, os, kind }
}

export function deviceTitle(name: DeviceName, fallback: string): string {
  const parts = [name.browser, name.os].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : fallback
}
