import type { MiddlewareHandler } from 'hono'
import type { HttpEnv } from '../context.ts'
import { errorResponse } from '../responses.ts'

/**
 * Routing in Hono (and in the auth SDK) decodes and normalizes paths in different ways, so the API accepts only
 * plain paths: no percent-encoding, no empty or dot segments, and the URL must already be in its normalized form.
 * Everything else is a 404, which keeps `/api/auth/sign%2Din/email`-style variants away from every router.
 */
export function pathGuard(): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const url = c.req.url
    const start = url.indexOf('/', url.indexOf(':') + 4)
    const end = [url.indexOf('?', start), url.indexOf('#', start)].filter((i) => i >= 0)
    const rawPath = url.slice(start, end.length > 0 ? Math.min(...end) : undefined)
    const normalized = new URL(url).pathname
    if (
      rawPath !== normalized ||
      rawPath.includes('%') ||
      rawPath.includes('//') ||
      /\/\.\.?(\/|$)/.test(rawPath) ||
      rawPath.includes('\\')
    ) {
      return errorResponse(c, 'NOT_FOUND', 'Not found')
    }
    await next()
  }
}
