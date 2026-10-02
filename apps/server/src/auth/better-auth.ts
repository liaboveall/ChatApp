/**
 * The Better Auth instance (docs/03 section 3, docs/05 section 3.1, D-058, V-13).
 *
 * The SDK is used for what it does well and is easy to verify: password hashing, signed session cookies, session
 * lifecycle, and the WebAuthn ceremonies for passkeys. Everything that changes identity state (registration,
 * verification, password reset/change, device revocation) is implemented in the domain, because the SDK cannot
 * share our transaction (its `after` hooks run after commit) and cannot express our locks, epochs and origins.
 *
 *  - Sign-up, user/account creation and deletion are refused inside the SDK as a second line of defence.
 *  - A session can only be created for an active, verified, non-bot, unbanned account, and gets its device origin and
 *    the account's current auth epoch in the same hook (the SDK has no notion of either).
 *  - No cookie cache, no secondary storage, no built-in rate limiter, no telemetry.
 */
import { passkey } from '@better-auth/passkey'
import { AppError, LIMITS } from '@chatapp/contracts'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import type { Deps } from '../domain/deps.ts'
import { beginLogin } from '../domain/sessions.ts'
import { describeError } from '../lib/logger.ts'

/** Header our gateway overwrites with the verified client IP, so the SDK records it in `sessions.ip_address`. */
export const CLIENT_IP_HEADER = 'x-chatapp-client-ip'

const DAY = 24 * 60 * 60

export type CookieNames = {
  sessionToken: string
  dontRemember: string
  passkeyChallenge: string
}

/**
 * Production uses `__Host-` names (Secure, Path=/, no Domain) when the site is https; development over http uses
 * plain names because browsers refuse Secure cookies there. SDK defaults would give `__Secure-` instead (V-05).
 */
export function cookieNames(origin: string): CookieNames {
  const prefix = origin.startsWith('https://') ? '__Host-' : ''
  return {
    sessionToken: `${prefix}chatapp.session_token`,
    dontRemember: `${prefix}chatapp.dont_remember`,
    passkeyChallenge: `${prefix}chatapp.passkey_challenge`,
  }
}

export function createAuth(deps: Deps, options: { baseOrigin: string; secret: string }) {
  const secure = options.baseOrigin.startsWith('https://')
  const names = cookieNames(options.baseOrigin)
  const attributes = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure }
  const rpID = new URL(options.baseOrigin).hostname

  const refuse = (what: string) => () => {
    throw new APIError('FORBIDDEN', {
      code: 'DISABLED',
      message: `${what} is handled by the application`,
    })
  }

  return betterAuth({
    appName: deps.config.product.name,
    baseURL: options.baseOrigin,
    basePath: '/api/auth',
    secret: options.secret,
    trustedOrigins: [options.baseOrigin],
    database: drizzleAdapter(deps.db, { provider: 'pg', usePlural: true, transaction: true }),
    telemetry: { enabled: false },
    logger: {
      level: 'error',
      // SDK messages can contain emails and other submitted values: log the error class only.
      log: (level, _message, ...args) => {
        if (level !== 'error') return
        const error = args.find((arg): arg is Error => arg instanceof Error)
        deps.log.error('auth.sdk_error', error ? describeError(error) : { reason: 'unknown' })
      },
    },
    advanced: {
      // Our own limiter and origin check run first; the SDK's origin check stays on as defence in depth.
      database: { generateId: () => deps.newId() },
      // Names carry the prefix themselves, so the SDK must not add its own `__Secure-` in front.
      useSecureCookies: false,
      cookiePrefix: 'chatapp',
      cookies: {
        session_token: { name: names.sessionToken, attributes },
        dont_remember: { name: names.dontRemember, attributes },
      },
      defaultCookieAttributes: attributes,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER], ipv6Subnet: 64 },
    },
    rateLimit: { enabled: false },
    session: {
      expiresIn: LIMITS.sessionTtlDays * DAY,
      updateAge: LIMITS.sessionRefreshAgeDays * DAY,
      // Every request reads the current session from Postgres; a cache would outlive a revocation (docs/03 5.8).
      cookieCache: { enabled: false },
      additionalFields: {
        authEpoch: { type: 'number', required: true, input: false },
        authorizationOriginId: { type: 'string', required: true, input: false },
      },
    },
    user: {
      // Declared so the SDK's schema check knows the column exists. `input: false` keeps clients from setting it, and
      // because it is required the SDK cannot create a user on its own (only the domain writes usernames).
      additionalFields: {
        username: { type: 'string', required: true, input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: LIMITS.passwordMinLength,
      maxPasswordLength: LIMITS.passwordMaxLength,
    },
    emailVerification: {
      sendOnSignUp: false,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
    },
    plugins: [
      passkey({
        rpID,
        rpName: deps.config.product.name,
        origin: options.baseOrigin,
        advanced: { webAuthnChallengeCookie: names.passkeyChallenge },
      }),
    ],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            try {
              const login = await beginLogin(deps, String(session.userId))
              return {
                data: { authEpoch: login.authEpoch, authorizationOriginId: login.originId },
              }
            } catch (error) {
              if (error instanceof AppError) {
                throw new APIError('FORBIDDEN', {
                  code: 'ACCOUNT_NOT_ACTIVE',
                  message: 'Account is not allowed to sign in',
                })
              }
              throw error
            }
          },
        },
      },
      user: {
        create: { before: refuse('Account creation') },
        update: { before: refuse('Account changes') },
        delete: { before: refuse('Account deletion') },
      },
      account: {
        create: { before: refuse('Account linking') },
        delete: { before: refuse('Account unlinking') },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
