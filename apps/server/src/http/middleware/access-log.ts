import type { MiddlewareHandler } from 'hono'
import type { HttpEnv, Services } from '../context.ts'

/**
 * One allowlisted record per request (D-077): request id, the matched ROUTE PATTERN (never the URL), method, status,
 * duration and the verified client IP. Unmatched requests log `unknown`.
 */
export function accessLog(services: Pick<Services, 'log'>): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const started = performance.now()
    try {
      await next()
    } finally {
      // A wildcard pattern means no concrete handler matched (or a catch-all answered): log `unknown` unless the
      // catch-all labelled the allowlisted path it served. The URL itself is never logged.
      const pattern = c.req.routePath
      const route = c.get('routeLabel') ?? (pattern.endsWith('*') ? 'unknown' : pattern)
      services.log.info('http.request', {
        requestId: c.get('requestId'),
        route,
        method: c.req.method,
        status: c.res.status,
        durationMs: Math.round(performance.now() - started),
        ip: c.get('clientIp'),
        userId: c.get('principal')?.userId ?? null,
      })
    }
  }
}
