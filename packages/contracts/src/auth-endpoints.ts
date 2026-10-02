/**
 * Exact allowlist of HTTP endpoints under /api/auth (D-058, docs/05 section 3.1, V-13).
 *
 * Everything not listed here is answered with 404 before it can reach the Better Auth handler, so a route that
 * a future SDK version adds stays closed until a person reviews it and adds it here. Matching is on the exact
 * method and the URL pathname as parsed by `new URL()`: no case folding, no trailing-slash tolerance, no
 * percent-decoding.
 *
 * `controlled` endpoints are implemented by this application (they validate, rate-limit and write through domain
 * code in one transaction); `sdk` endpoints are forwarded to the Better Auth handler after the same guards.
 */

export type AuthEndpointAccess = 'anonymous' | 'session'
export type AuthEndpointHandler = 'controlled' | 'sdk'

export type AuthEndpoint = {
  readonly method: 'GET' | 'POST'
  readonly path: string
  readonly capability: string
  readonly access: AuthEndpointAccess
  readonly handler: AuthEndpointHandler
}

export const AUTH_BASE_PATH = '/api/auth'

export const AUTH_ENDPOINTS: readonly AuthEndpoint[] = [
  {
    method: 'POST',
    path: '/api/auth/sign-up/email',
    capability: 'register',
    access: 'anonymous',
    handler: 'controlled',
  },
  {
    method: 'POST',
    path: '/api/auth/sign-in/email',
    capability: 'login',
    access: 'anonymous',
    handler: 'controlled',
  },
  {
    method: 'POST',
    path: '/api/auth/sign-out',
    capability: 'logout',
    access: 'session',
    handler: 'controlled',
  },
  {
    method: 'POST',
    path: '/api/auth/change-password',
    capability: 'change-password',
    access: 'session',
    handler: 'controlled',
  },
  {
    method: 'POST',
    path: '/api/auth/verification/request',
    capability: 'verification',
    access: 'anonymous',
    handler: 'controlled',
  },
  {
    method: 'POST',
    path: '/api/auth/verification/consume',
    capability: 'verification',
    access: 'anonymous',
    handler: 'controlled',
  },
  {
    method: 'POST',
    path: '/api/auth/password/request-reset',
    capability: 'password-reset',
    access: 'anonymous',
    handler: 'controlled',
  },
  {
    method: 'POST',
    path: '/api/auth/password/consume-reset',
    capability: 'password-reset',
    access: 'anonymous',
    handler: 'controlled',
  },
  {
    method: 'GET',
    path: '/api/auth/passkey/generate-authenticate-options',
    capability: 'passkey-login',
    access: 'anonymous',
    handler: 'sdk',
  },
  {
    method: 'POST',
    path: '/api/auth/passkey/verify-authentication',
    capability: 'passkey-login',
    access: 'anonymous',
    handler: 'sdk',
  },
  {
    method: 'GET',
    path: '/api/auth/passkey/generate-register-options',
    capability: 'passkey-manage',
    access: 'session',
    handler: 'sdk',
  },
  {
    method: 'POST',
    path: '/api/auth/passkey/verify-registration',
    capability: 'passkey-manage',
    access: 'session',
    handler: 'sdk',
  },
  {
    method: 'GET',
    path: '/api/auth/passkey/list-user-passkeys',
    capability: 'passkey-manage',
    access: 'session',
    handler: 'sdk',
  },
  {
    method: 'POST',
    path: '/api/auth/passkey/update-passkey',
    capability: 'passkey-manage',
    access: 'session',
    handler: 'sdk',
  },
  {
    method: 'POST',
    path: '/api/auth/passkey/delete-passkey',
    capability: 'passkey-manage',
    access: 'session',
    handler: 'sdk',
  },
]

const BY_KEY = new Map(
  AUTH_ENDPOINTS.map((endpoint) => [`${endpoint.method} ${endpoint.path}`, endpoint]),
)

/** Returns the endpoint for an exact method + pathname, or undefined (= 404). */
export function findAuthEndpoint(method: string, pathname: string): AuthEndpoint | undefined {
  return BY_KEY.get(`${method} ${pathname}`)
}
