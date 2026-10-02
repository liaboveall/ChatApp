import { AppError } from '@chatapp/contracts'
import type { Context, MiddlewareHandler } from 'hono'
import { CLIENT_IP_HEADER, cookieNames } from '../../auth/better-auth.ts'
import { sessionCookieDeletions } from '../../auth/cookies.ts'
import { authenticateSession } from '../../auth/session-auth.ts'
import type { SessionPrincipal } from '../../domain/principal.ts'
import type { HttpEnv, Services } from '../context.ts'
import { POLICIES } from '../policies.ts'

/** Headers handed to the SDK: only what it needs, with the IP header set from our verified value (never the client's). */
export function sdkHeaders(c: Context<HttpEnv>, origin: string): Headers {
  const headers = new Headers()
  for (const name of ['cookie', 'user-agent', 'content-type']) {
    const value = c.req.header(name)
    if (value !== undefined) headers.set(name, value)
  }
  headers.set('origin', origin)
  headers.set(CLIENT_IP_HEADER, c.get('clientIp'))
  return headers
}

export type { Authenticated } from '../../auth/session-auth.ts'

/** HTTP flavour of the shared authentication: builds the SDK headers from the request. */
export function authenticate(services: Services, c: Context<HttpEnv>) {
  return authenticateSession(services, sdkHeaders(c, services.config.origin))
}

/** Requires a valid session and sets `principal`; a dead session answers 401 and tells the browser to drop its cookie. */
export function requireSession(services: Services): MiddlewareHandler<HttpEnv> {
  const names = cookieNames(services.config.origin)
  const secure = services.config.origin.startsWith('https://')
  return async (c, next) => {
    const result = await authenticate(services, c)
    if (!result.principal) {
      if (result.staleCookie) c.get('pendingCookies').push(...sessionCookieDeletions(names, secure))
      throw new AppError('UNAUTHENTICATED', 'Sign in required')
    }
    c.set('principal', result.principal)
    c.get('pendingCookies').push(...result.refreshedCookies)
    await services.limiter.enforce([{ policy: POLICIES.apiUser, subject: result.principal.userId }])
    await next()
  }
}

export function principalOf(c: Context<HttpEnv>): SessionPrincipal {
  const principal = c.get('principal')
  if (!principal) throw new AppError('UNAUTHENTICATED', 'Sign in required')
  return principal
}
