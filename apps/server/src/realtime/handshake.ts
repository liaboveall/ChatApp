/**
 * Decides what a WebSocket upgrade request is worth, before any socket exists (docs/05 section 4.1). Browsers cannot read
 * the HTTP status of a refused upgrade, so the server accepts the upgrade and then closes with a code the client can act
 * on: 4401 not signed in, 4403 foreign origin, 4429 too many attempts, 1013 dependency down.
 */
import { WS_CLOSE } from '@chatapp/contracts'
import { CLIENT_IP_HEADER } from '../auth/better-auth.ts'
import { authenticateSession } from '../auth/session-auth.ts'
import type { Services } from '../http/context.ts'
import { POLICIES } from '../http/policies.ts'
import { rateLimitIpKey } from '../lib/ip.ts'
import type { ConnectionIdentity } from './gateway.ts'

export type Handshake =
  | { ok: true; identity: ConnectionIdentity }
  | { ok: false; code: number; reason: string }

export async function prepareHandshake(
  services: Services,
  request: Request,
  clientIp: string,
): Promise<Handshake> {
  if (request.headers.get('origin') !== services.config.origin) {
    return { ok: false, code: WS_CLOSE.ORIGIN_NOT_ALLOWED, reason: 'origin not allowed' }
  }
  try {
    const result = await services.limiter.hit(POLICIES.wsConnectIp, rateLimitIpKey(clientIp))
    if (!result.allowed)
      return { ok: false, code: WS_CLOSE.TOO_MANY_MESSAGES, reason: 'too many attempts' }
  } catch {
    return { ok: false, code: WS_CLOSE.TRY_AGAIN_LATER, reason: 'dependency unavailable' }
  }
  try {
    const headers = new Headers()
    const cookie = request.headers.get('cookie')
    if (cookie) headers.set('cookie', cookie)
    headers.set('origin', services.config.origin)
    headers.set(CLIENT_IP_HEADER, clientIp)
    const result = await authenticateSession(services, headers)
    if (!result.principal)
      return { ok: false, code: WS_CLOSE.UNAUTHENTICATED, reason: 'not signed in' }
    return {
      ok: true,
      identity: {
        sessionId: result.principal.sessionId,
        userId: result.principal.userId,
        originId: result.principal.originId,
        authEpoch: result.principal.authEpoch,
        restoreEpoch: result.principal.restoreEpoch,
      },
    }
  } catch {
    return { ok: false, code: WS_CLOSE.TRY_AGAIN_LATER, reason: 'dependency unavailable' }
  }
}
