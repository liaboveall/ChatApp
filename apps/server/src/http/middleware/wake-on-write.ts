import type { MiddlewareHandler } from 'hono'
import type { HttpEnv, Services } from '../context.ts'

/** After a successful state-changing request, nudge the dispatcher: committed work should not wait for the next scan. */
export function wakeOnWrite(services: Pick<Services, 'wake'>): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    await next()
    const method = c.req.method
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && c.res.status < 400) {
      services.wake()
    }
  }
}
