/**
 * The sender a worker uses for browser push (docs/03 section 7, SEC-23, D-065): it turns one message for one subscription
 * into the encrypted, VAPID-signed request of RFC 8291/8292, hands it to a transport, and classifies the answer for the
 * domain. It decides nothing about *whether* to send (preferences, permissions, sessions): that is the domain's, checked
 * right before the call.
 *
 * Delivery is at-least-once at best. A request that timed out may have reached the push service, so the answer
 * "retry" can duplicate a notification; nothing here claims otherwise (D-037, docs/03 section 7).
 */
import { LIMITS, type PushPayload } from '@chatapp/contracts'
import { EndpointError, type EndpointPolicy } from './push-endpoints.ts'
import { type PushTransport, TransportError } from './push-transport.ts'
import {
  b64u,
  encryptWebPush,
  type VapidKeys,
  vapidAuthorization,
  vapidKeysMatch,
} from './web-push.ts'

export type PushTarget = { endpoint: string; p256dh: string; auth: string }

export type PushMessage = {
  payload: PushPayload
  /** RFC 8030 `Urgency`: `high` wakes a sleeping phone, `normal` waits for it. */
  urgency: 'low' | 'normal' | 'high'
  /** RFC 8030 `Topic`: a newer message with the same topic replaces one the push service still holds. */
  topic?: string
}

export type PushOutcome =
  /** The push service accepted it (201, or 200/202 from services that answer differently). */
  | { kind: 'delivered'; status: number }
  /** The subscription is dead or may no longer be used: remove it. */
  | { kind: 'gone'; reason: string; status: number | null }
  /** The push service refused this message for good (a bad request, rejected VAPID, too large): do not retry it. */
  | { kind: 'rejected'; reason: string; status: number | null }
  /** Rate limited, a server error or no answer: try again later. Whether the first try arrived is unknown. */
  | { kind: 'retry'; reason: string; retryAfterMs: number | null }

export interface PushSender {
  send(target: PushTarget, message: PushMessage): Promise<PushOutcome>
}

/** What the composition roots put into `Deps.push`. */
export type PushService = {
  /** The application server key browsers subscribe with. */
  vapidPublicKey: string
  policy: EndpointPolicy
  sender: PushSender
}

export function classifyStatus(status: number, retryAfterSeconds: number | null): PushOutcome {
  if (status >= 200 && status < 300) return { kind: 'delivered', status }
  if (status === 404 || status === 410) return { kind: 'gone', reason: `http_${status}`, status }
  if (status === 429 || status === 408 || status >= 500) {
    return {
      kind: 'retry',
      reason: `http_${status}`,
      retryAfterMs: retryAfterSeconds === null ? null : retryAfterSeconds * 1000,
    }
  }
  // 400, 401, 403, 413 and the rest (a redirect is never followed): this message will not be accepted by retrying.
  return { kind: 'rejected', reason: `http_${status}`, status }
}

export function createPushSender(options: {
  vapid: VapidKeys
  transport: PushTransport
  policy: EndpointPolicy
  now?: () => number
}): PushSender {
  if (!vapidKeysMatch(options.vapid)) throw new Error('VAPID key pair is inconsistent')
  const now = options.now ?? Date.now
  return {
    async send(target, message) {
      const verdict = options.policy.check(target.endpoint)
      if (!verdict.ok) return { kind: 'gone', reason: `endpoint_${verdict.reason}`, status: null }
      const plaintext = Buffer.from(JSON.stringify(message.payload), 'utf8')
      if (plaintext.length > LIMITS.pushPayloadMaxBytes) {
        return { kind: 'rejected', reason: 'payload_too_large', status: null }
      }
      let body: Buffer
      try {
        body = encryptWebPush(plaintext, { p256dh: target.p256dh, auth: target.auth })
      } catch {
        // The keys stored with the subscription are not a usable P-256 key: nothing can ever be sent to it.
        return { kind: 'gone', reason: 'bad_subscription_keys', status: null }
      }
      const headers: Record<string, string> = {
        Authorization: vapidAuthorization(options.vapid, verdict.url.origin, now()),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(LIMITS.pushTtlSeconds),
        Urgency: message.urgency,
      }
      if (message.topic !== undefined) headers.Topic = message.topic
      try {
        const response = await options.transport.post({
          endpoint: target.endpoint,
          headers,
          body,
        })
        return classifyStatus(response.status, response.retryAfterSeconds)
      } catch (error) {
        if (error instanceof EndpointError) {
          // The name now resolves into the private network, or not at all: do not send, and keep trying only while
          // the resolver is down (it may recover); an address inside the network never becomes acceptable.
          return error.reason === 'dns_failed'
            ? { kind: 'retry', reason: 'dns_failed', retryAfterMs: null }
            : { kind: 'gone', reason: `endpoint_${error.reason}`, status: null }
        }
        if (error instanceof TransportError) {
          return error.code === 'bad_request'
            ? { kind: 'rejected', reason: 'bad_request', status: null }
            : { kind: 'retry', reason: error.code, retryAfterMs: null }
        }
        return { kind: 'retry', reason: 'transport_error', retryAfterMs: null }
      }
    },
  }
}

// ───────── test environment ─────────

/** One request as it would have gone to the push service (APP_ENV=test only, docs/08 scenario 9). */
export type CapturedPush = {
  endpoint: string
  headers: Record<string, string>
  bodyBase64Url: string
  at: string
}

/**
 * The simulated push service of the end-to-end tests: the same pipeline as production up to the network, but the
 * request is recorded instead of sent. The test reads it back, decrypts it as the browser would and checks the VAPID
 * signature; the real transport is covered by the integration tests against a local TLS server. The composition roots
 * install this only when APP_ENV is `test`.
 */
export function createCaptureTransport(
  store: { push(entry: CapturedPush): Promise<void> },
  now: () => number = Date.now,
): PushTransport {
  return {
    async post(request) {
      await store.push({
        endpoint: request.endpoint,
        headers: request.headers,
        bodyBase64Url: b64u.encode(request.body),
        at: new Date(now()).toISOString(),
      })
      return { status: 201, retryAfterSeconds: null }
    },
  }
}
