/**
 * The only URLs a message may link to (docs/07 SEC-05, D-145): absolute http, https and mailto. Everything else, whatever
 * its spelling (javascript: in any case or entity-encoded, data:, file:, tel:, a relative path, a protocol-relative
 * `//host`), is not a link at all: the text stays, the link goes.
 */
const SAFE_PROTOCOL = /^(?:https?|mailto):/i

export function safeUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!SAFE_PROTOCOL.test(trimmed)) return null
  try {
    const parsed = new URL(trimmed)
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? trimmed : null
  } catch {
    return null
  }
}

/** Whether a safe URL opens in a new tab (mail links do not). */
export const opensInNewTab = (safe: string): boolean => !safe.toLowerCase().startsWith('mailto:')
