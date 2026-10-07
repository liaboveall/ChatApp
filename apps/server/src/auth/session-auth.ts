/**
 * Cookie -> SDK session (signature, expiry, rolling refresh) -> our principal check (account state, auth epoch, origin,
 * restore generation). Shared by the HTTP middleware and the WebSocket upgrade. Nothing is cached: every call reads
 * the current state from Postgres.
 */
import type { Deps } from '../domain/deps.ts'
import type { SessionPrincipal } from '../domain/principal.ts'
import { resolveSessionPrincipal } from '../domain/sessions.ts'
import type { Auth } from './better-auth.ts'

export type Authenticated =
  | { principal: SessionPrincipal; refreshedCookies: string[] }
  | { principal: null; staleCookie: boolean }

export async function authenticateSession(
  services: { auth: Auth; deps: Deps },
  sdkRequestHeaders: Headers,
  options: { readOnly?: boolean } = {},
): Promise<Authenticated> {
  if (!sdkRequestHeaders.get('cookie')) return { principal: null, staleCookie: false }
  const result = await services.auth.api.getSession({
    headers: sdkRequestHeaders,
    returnHeaders: true,
    ...(options.readOnly ? { query: { disableRefresh: true } } : {}),
  })
  const found = result.response
  if (!found) return { principal: null, staleCookie: true }
  const session = found.session as typeof found.session & {
    authEpoch: number
    authorizationOriginId: string
  }
  const principal = await resolveSessionPrincipal(services.deps, {
    id: session.id,
    userId: session.userId,
    expiresAt: session.expiresAt,
    authEpoch: session.authEpoch,
    authorizationOriginId: session.authorizationOriginId,
  })
  if (!principal) return { principal: null, staleCookie: true }
  return { principal, refreshedCookies: result.headers.getSetCookie() }
}
