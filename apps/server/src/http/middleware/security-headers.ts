import type { MiddlewareHandler } from 'hono'
import type { HttpEnv } from '../context.ts'

/**
 * Also the single place where cookies queued by handlers and middleware (`pendingCookies`: SDK session refresh,
 * cookie deletions) are attached. Handlers must NOT reassign `c.res` themselves: Hono then ignores the Response the
 * handler returns.
 *
 * Headers for API responses (SEC-22: HSTS is the gateway's job, everything else on API responses is ours). Responses
 * are never cached, never sniffed, and never framed; JSON gets a CSP that allows nothing.
 */
export function securityHeaders(): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    await next()
    const original = c.res
    const headers = new Headers(original.headers)
    headers.set('Cache-Control', 'no-store')
    headers.set('X-Content-Type-Options', 'nosniff')
    headers.set('Referrer-Policy', 'no-referrer')
    headers.set('Cross-Origin-Resource-Policy', 'same-origin')
    if (!headers.has('Content-Security-Policy')) {
      headers.set(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      )
    }
    for (const cookie of c.get('pendingCookies')) headers.append('Set-Cookie', cookie)
    // Response objects from fetch-like sources have immutable headers, so rebuild instead of mutating.
    c.res = new Response(original.body, {
      status: original.status,
      statusText: original.statusText,
      headers,
    })
  }
}
