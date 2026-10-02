/**
 * The /api/auth surface (D-058, docs/05 section 3.1). One catch-all gateway enforces the exact allowlist from
 * contracts/auth-endpoints; controlled endpoints are implemented here on top of the domain, passkey ceremonies are
 * forwarded to the SDK after strict validation. Anything not on the list never reaches the SDK: it is a plain 404.
 */
import {
  AppError,
  acceptedResponseSchema,
  changePasswordRequestSchema,
  errorBodySchema,
  findAuthEndpoint,
  IDEMPOTENCY_KEY_HEADER,
  INVITE_CODE_HEADER,
  normalizeEmail,
  okResponseSchema,
  passkeyDeleteSchema,
  passkeyRegisterOptionsQuerySchema,
  passkeyUpdateSchema,
  passkeyVerifyAuthenticationSchema,
  passkeyVerifyRegistrationSchema,
  passwordResetConsumeSchema,
  passwordResetRequestSchema,
  signInErrorSchema,
  signInRequestSchema,
  signUpRequestSchema,
  signUpResponseSchema,
  verificationConsumeSchema,
  verificationRequestSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { cookieNames } from '../../auth/better-auth.ts'
import { sessionCookieDeletions } from '../../auth/cookies.ts'
import {
  changePassword,
  consumePasswordReset,
  consumeVerification,
  requestPasswordReset,
  requestVerification,
} from '../../domain/credentials.ts'
import { registerAccount } from '../../domain/registration.ts'
import { endSession } from '../../domain/sessions.ts'
import { hmacSha256Hex } from '../../lib/crypto.ts'
import { rateLimitIpKey } from '../../lib/ip.ts'
import type { HttpEnv, Services } from '../context.ts'
import { authenticate, principalOf, requireSession, sdkHeaders } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { errorResponse, isSdkApiError } from '../responses.ts'

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})
const body = <T extends z.ZodType>(schema: T) => ({
  required: true as const,
  content: { 'application/json': { schema } },
})
const err = (description: string) => json(errorBodySchema, description)

const signUpRoute = createRoute({
  method: 'post',
  path: '/api/auth/sign-up/email',
  tags: ['auth'],
  summary: 'Register with an invitation (code in the X-Invite-Code header, key in Idempotency-Key)',
  request: { body: body(signUpRequestSchema) },
  responses: {
    200: json(
      signUpResponseSchema,
      'Verification email on its way (same answer if the email is already known)',
    ),
    400: err('Invitation invalid'),
    409: err('Username taken, or idempotency conflict'),
    422: err('Validation failed'),
    429: err('Rate limited'),
  },
})

const signInRoute = createRoute({
  method: 'post',
  path: '/api/auth/sign-in/email',
  tags: ['auth'],
  summary: 'Sign in with email and password; the session is a cookie, the body carries no token',
  request: { body: body(signInRequestSchema) },
  responses: {
    200: json(okResponseSchema, 'Signed in (Set-Cookie)'),
    401: json(signInErrorSchema, 'Wrong email or password'),
    403: json(signInErrorSchema, 'Account cannot sign in (unverified or inactive)'),
    429: err('Rate limited'),
  },
})

const signOutRoute = createRoute({
  method: 'post',
  path: '/api/auth/sign-out',
  tags: ['auth'],
  summary: 'End this session (delegated work continues). Always succeeds.',
  responses: { 200: json(okResponseSchema, 'Signed out') },
})

const changePasswordRoute = createRoute({
  method: 'post',
  path: '/api/auth/change-password',
  tags: ['auth'],
  summary: 'Change the password; other sessions end, this one continues under a new origin',
  security: [{ cookieAuth: [] }],
  request: { body: body(changePasswordRequestSchema) },
  responses: {
    200: json(okResponseSchema, 'Changed'),
    401: err('Not signed in'),
    403: err('Current password incorrect'),
    422: err('New password not acceptable'),
    429: err('Rate limited'),
  },
})

const verificationRequestRoute = createRoute({
  method: 'post',
  path: '/api/auth/verification/request',
  tags: ['auth'],
  summary: 'Send (again) the verification email; the answer never depends on the account',
  request: { body: body(verificationRequestSchema) },
  responses: { 202: json(acceptedResponseSchema, 'Accepted'), 429: err('Rate limited') },
})

const verificationConsumeRoute = createRoute({
  method: 'post',
  path: '/api/auth/verification/consume',
  tags: ['auth'],
  summary: 'Consume a verification credential from the email link; does not sign in',
  request: { body: body(verificationConsumeSchema) },
  responses: {
    200: json(okResponseSchema, 'Verified'),
    400: err('Credential invalid, used or expired'),
    429: err('Rate limited'),
  },
})

const resetRequestRoute = createRoute({
  method: 'post',
  path: '/api/auth/password/request-reset',
  tags: ['auth'],
  summary: 'Email a password-reset link; the answer never depends on the account',
  request: { body: body(passwordResetRequestSchema) },
  responses: { 202: json(acceptedResponseSchema, 'Accepted'), 429: err('Rate limited') },
})

const resetConsumeRoute = createRoute({
  method: 'post',
  path: '/api/auth/password/consume-reset',
  tags: ['auth'],
  summary: 'Set a new password with a reset credential; ends every session',
  request: { body: body(passwordResetConsumeSchema) },
  responses: {
    200: json(okResponseSchema, 'Password changed'),
    400: err('Credential invalid, used or expired'),
    422: err('New password not acceptable'),
    429: err('Rate limited'),
  },
})

/** Anonymous "request" endpoints take at least this long, so existing and unknown accounts cost the same time. */
const MIN_REQUEST_MS = 300

async function padTo(started: number, minMs: number): Promise<void> {
  const remaining = minMs - (performance.now() - started)
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
}

const accountSubject = (services: Services, email: string): string =>
  hmacSha256Hex(services.config.auth.secret, `rl-account:${normalizeEmail(email)}`)

const SIGN_IN_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'Invalid email or password',
  EMAIL_NOT_VERIFIED: 'Email is not verified',
  ACCOUNT_NOT_ACTIVE: 'Account is not allowed to sign in',
}

/** Sign-in errors keep the SDK's `{ code, message }` shape (docs/05 section 1); unknown codes collapse to the generic one. */
function signInFailure(c: Context<HttpEnv>, code: unknown): Response {
  const known =
    typeof code === 'string' && code in SIGN_IN_MESSAGES ? code : 'INVALID_EMAIL_OR_PASSWORD'
  const status = known === 'INVALID_EMAIL_OR_PASSWORD' ? 401 : 403
  return c.json({ code: known, message: SIGN_IN_MESSAGES[known] }, status)
}

/** Removes credential-like fields from SDK JSON before it reaches the browser (tokens live in the HttpOnly cookie only). */
function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (/^(token|accessToken|refreshToken|idToken|password)$/i.test(key)) continue
      out[key] = stripSecrets(inner)
    }
    return out
  }
  return value
}

const PASSKEY_BODIES: Record<string, z.ZodType> = {
  '/api/auth/passkey/verify-registration': passkeyVerifyRegistrationSchema,
  '/api/auth/passkey/verify-authentication': passkeyVerifyAuthenticationSchema,
  '/api/auth/passkey/update-passkey': passkeyUpdateSchema,
  '/api/auth/passkey/delete-passkey': passkeyDeleteSchema,
}

export function authRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  const { deps, limiter, config } = services
  const names = cookieNames(config.origin)
  const secure = config.origin.startsWith('https://')
  const ipKey = (c: Context<HttpEnv>) => rateLimitIpKey(c.get('clientIp'))

  // ── registration ──
  app.openapi(signUpRoute, async (c) => {
    const input = c.req.valid('json')
    await limiter.enforce([{ policy: POLICIES.registerIp, subject: ipKey(c) }])
    const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER)
    if (idempotencyKey === undefined) {
      throw new AppError('VALIDATION_FAILED', 'Idempotency-Key header is required', {
        details: { field: 'idempotencyKey' },
      })
    }
    const result = await registerAccount(deps, {
      email: input.email,
      username: input.username,
      displayName: input.name,
      password: input.password,
      inviteCode: c.req.header(INVITE_CODE_HEADER) ?? '',
      idempotencyKey,
      requestId: c.get('requestId'),
    })
    return c.json(result, 200)
  })

  // ── login / logout ──
  app.openapi(signInRoute, async (c) => {
    const input = c.req.valid('json')
    await limiter.enforce([
      { policy: POLICIES.loginIp, subject: ipKey(c) },
      { policy: POLICIES.loginAccount, subject: accountSubject(services, input.email) },
    ])
    let response: Response
    try {
      response = await services.auth.api.signInEmail({
        body: { email: input.email, password: input.password, rememberMe: input.rememberMe },
        headers: sdkHeaders(c, config.origin),
        asResponse: true,
      })
    } catch (error) {
      if (isSdkApiError(error)) return signInFailure(c, error.body?.code) as never
      throw error
    }
    if (response.status >= 400) {
      const failure = (await response.json().catch(() => undefined)) as
        | { code?: unknown }
        | undefined
      return signInFailure(c, failure?.code) as never
    }
    // The SDK's JSON carries the session token; the browser only gets the cookie.
    c.get('pendingCookies').push(...response.headers.getSetCookie())
    return c.json({ status: 'ok' as const }, 200)
  })

  app.openapi(signOutRoute, async (c) => {
    const result = await authenticate(services, c)
    if (result.principal) {
      await endSession(deps, {
        id: result.principal.sessionId,
        userId: result.principal.userId,
        authorizationOriginId: result.principal.originId,
      })
    } else if (c.req.header('cookie')) {
      // Whatever the cookie names, let the SDK drop a matching session row.
      await services.auth.api
        .signOut({ headers: sdkHeaders(c, config.origin) })
        .catch(() => undefined)
    }
    c.get('pendingCookies').push(...sessionCookieDeletions(names, secure))
    return c.json({ status: 'ok' as const }, 200)
  })

  app.use('/api/auth/change-password', requireSession(services))
  app.openapi(changePasswordRoute, async (c) => {
    const principal = principalOf(c)
    await limiter.enforce([
      { policy: POLICIES.changePasswordUser, subject: principal.userId },
      { policy: POLICIES.loginIp, subject: ipKey(c) },
    ])
    await changePassword(deps, principal, c.req.valid('json'))
    return c.json({ status: 'ok' as const }, 200)
  })

  // ── email verification ──
  app.openapi(verificationRequestRoute, async (c) => {
    const started = performance.now()
    const { email } = c.req.valid('json')
    await limiter.enforce([
      { policy: POLICIES.verificationRequestIp, subject: ipKey(c) },
      { policy: POLICIES.verificationRequestAccount, subject: accountSubject(services, email) },
    ])
    await requestVerification(deps, { email })
    await padTo(started, MIN_REQUEST_MS)
    return c.json({ status: 'accepted' as const }, 202)
  })

  app.openapi(verificationConsumeRoute, async (c) => {
    await limiter.enforce([{ policy: POLICIES.verificationConsumeIp, subject: ipKey(c) }])
    await consumeVerification(deps, c.req.valid('json'))
    return c.json({ status: 'ok' as const }, 200)
  })

  // ── password reset ──
  app.openapi(resetRequestRoute, async (c) => {
    const started = performance.now()
    const { email } = c.req.valid('json')
    await limiter.enforce([
      { policy: POLICIES.resetRequestIp, subject: ipKey(c) },
      { policy: POLICIES.resetRequestAccount, subject: accountSubject(services, email) },
    ])
    await requestPasswordReset(deps, { email })
    await padTo(started, MIN_REQUEST_MS)
    return c.json({ status: 'accepted' as const }, 202)
  })

  app.openapi(resetConsumeRoute, async (c) => {
    await limiter.enforce([{ policy: POLICIES.resetConsumeIp, subject: ipKey(c) }])
    await consumePasswordReset(deps, c.req.valid('json'))
    return c.json({ status: 'ok' as const }, 200)
  })

  // ── gateway for everything else under /api/auth: exact allowlist, then the SDK (passkeys only) ──
  app.all('/api/auth/*', async (c) => {
    const url = new URL(c.req.url)
    const endpoint = findAuthEndpoint(c.req.method, url.pathname)
    // Controlled endpoints were answered above; anything else, or a listed one with the wrong handler, is a 404.
    if (endpoint?.handler !== 'sdk') return errorResponse(c, 'NOT_FOUND', 'Not found')

    c.set('routeLabel', endpoint.path)
    await limiter.enforce([{ policy: POLICIES.passkeyIp, subject: ipKey(c) }])
    if (endpoint.access === 'session') {
      const result = await authenticate(services, c)
      if (!result.principal) throw new AppError('UNAUTHENTICATED', 'Sign in required')
      c.set('principal', result.principal)
    }

    // Strict inputs: unknown query parameters and body fields are refused, not passed on.
    let search = ''
    if (c.req.method === 'GET') {
      if (endpoint.path.endsWith('/generate-register-options')) {
        const parsed = passkeyRegisterOptionsQuerySchema.safeParse(
          Object.fromEntries(url.searchParams),
        )
        if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Invalid query')
        const query = new URLSearchParams()
        for (const [key, value] of Object.entries(parsed.data))
          if (value !== undefined) query.set(key, value)
        search = query.size > 0 ? `?${query}` : ''
      } else if (url.search !== '') {
        throw new AppError('VALIDATION_FAILED', 'Unexpected query parameters')
      }
    }
    let payload: string | undefined
    if (c.req.method === 'POST') {
      const schema = PASSKEY_BODIES[endpoint.path]
      payload = await c.req.text()
      if (!schema?.safeParse(JSON.parse(payload === '' ? '{}' : payload)).success) {
        throw new AppError('VALIDATION_FAILED', 'Invalid request body')
      }
    }

    const headers = sdkHeaders(c, config.origin)
    const forwarded = new Request(`${config.origin}${url.pathname}${search}`, {
      method: c.req.method,
      headers,
      body: payload,
    })
    const response = await services.auth.handler(forwarded)
    const text = await response.text()
    let output: string = text
    try {
      output = JSON.stringify(stripSecrets(JSON.parse(text)))
    } catch {
      // Not JSON (empty body): pass through as is.
    }
    const result = new Response(output === '' ? null : output, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    })
    for (const cookie of response.headers.getSetCookie())
      result.headers.append('Set-Cookie', cookie)
    return result
  })
}
