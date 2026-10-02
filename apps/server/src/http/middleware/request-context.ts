import type { MiddlewareHandler } from 'hono'
import type { HttpEnv, Services } from '../context.ts'

/**
 * First middleware: a server-generated request id (client-supplied ones are ignored), the client IP resolved through
 * the trusted-proxy rules (SEC-28), and the overwriting of the IP header the auth SDK reads, so a client cannot forge it.
 */
export function requestContext(
  services: Pick<Services, 'deps' | 'resolveClientIp'>,
): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const requestId = services.deps.newId()
    c.set('requestId', requestId)
    c.set('pendingCookies', [])
    const peer = c.env?.peerAddress?.(c.req.raw)
    c.set(
      'clientIp',
      services.resolveClientIp(
        peer,
        c.req.header('x-forwarded-for') ?? null,
        c.req.header('x-real-ip') ?? null,
      ),
    )
    await next()
    c.res.headers.set('X-Request-Id', requestId)
  }
}
