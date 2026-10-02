import { AppError } from '@chatapp/contracts'
import type { MiddlewareHandler } from 'hono'
import type { HttpEnv } from '../context.ts'

/** SEC-13: every state-changing request must come from the site's own origin, or it is refused with 403. */
export function originGuard(allowedOrigin: string): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const method = c.req.method
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      if (c.req.header('origin') !== allowedOrigin) {
        throw new AppError('FORBIDDEN', 'Origin not allowed')
      }
    }
    await next()
  }
}
