/** Cookie helpers that follow the names and attributes configured for the SDK. */
import type { CookieNames } from './better-auth.ts'

type Attributes = { secure: boolean }

/** A Set-Cookie line that deletes a cookie of ours (same name, path and security attributes as when it was set). */
export function expiredCookie(name: string, attributes: Attributes): string {
  return [
    `${name}=`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(attributes.secure ? ['Secure'] : []),
  ].join('; ')
}

export function sessionCookieDeletions(names: CookieNames, secure: boolean): string[] {
  return [
    expiredCookie(names.sessionToken, { secure }),
    expiredCookie(names.dontRemember, { secure }),
  ]
}
