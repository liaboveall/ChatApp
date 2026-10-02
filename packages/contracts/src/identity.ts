/** Identity field rules shared by registration, profile and the web forms (docs/01 sections 4.1 and 4.3). */
import { z } from 'zod'
import { LIMITS } from './limits.ts'

/** Lower-case form used for storage and lookups. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Invite codes are 16 base32 characters; users may type spaces or hyphens. Returns null when malformed. */
export function normalizeInviteCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase()
  return new RegExp(`^[A-Z2-7]{${LIMITS.inviteCodeLength}}$`).test(code) ? code : null
}

/** Formats a normalized invite code for display: ABCD-EFGH-IJKL-MNOP. */
export function formatInviteCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-')
}

// Bidi controls, zero-width space, word joiner and BOM allow spoofing; ZWJ/ZWNJ stay for emoji and scripts that need them.
const FORBIDDEN_NAME_CHARS =
  /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function graphemeCount(text: string): number {
  let count = 0
  for (const _ of segmenter.segment(text)) count += 1
  return count
}

export const emailSchema = z.string().trim().max(LIMITS.emailMaxLength).pipe(z.email())

export const usernameSchema = z
  .string()
  .min(LIMITS.usernameMinLength)
  .max(LIMITS.usernameMaxLength)
  .regex(/^[a-z0-9_]+$/, 'Only lower-case letters, digits and underscores')

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.displayNameMaxCodeUnits)
  .refine((name) => graphemeCount(name) <= LIMITS.displayNameMaxGraphemes, {
    message: `At most ${LIMITS.displayNameMaxGraphemes} characters`,
  })
  .refine((name) => !FORBIDDEN_NAME_CHARS.test(name), {
    message: 'Contains control or invisible characters',
  })

/** Length only; the common-password list is checked on the server (SEC-10). */
export const passwordSchema = z.string().min(LIMITS.passwordMinLength).max(LIMITS.passwordMaxLength)

/** Opaque one-time credential from an email link: 256 random bits as base64url (D-076). */
export const authTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

export const uuidSchema = z.uuid()

export const timezoneSchema = z.string().refine(
  (zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone })
      return true
    } catch {
      return false
    }
  },
  { message: 'Unknown IANA time zone' },
)
