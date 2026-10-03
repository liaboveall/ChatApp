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

/** Unicode code points, the unit of the message length limit (an emoji counts once, however it is encoded). */
export function codePointCount(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** First `max` code points, never cutting a surrogate pair in half. */
export function truncateCodePoints(text: string, max: number): string {
  let out = ''
  let count = 0
  for (const char of text) {
    if (count >= max) break
    out += char
    count += 1
  }
  return out
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

/** A conversation name is shown to many people, so it follows the display-name rules and the 50-character limit. */
export const conversationNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.conversationNameMaxCodeUnits)
  .refine((name) => graphemeCount(name) <= LIMITS.conversationNameMaxGraphemes, {
    message: `At most ${LIMITS.conversationNameMaxGraphemes} characters`,
  })
  .refine((name) => !FORBIDDEN_NAME_CHARS.test(name), {
    message: 'Contains control or invisible characters',
  })

/**
 * NUL cannot be stored in PostgreSQL text; the other C0 controls (all but tab, line feed and carriage return) and DEL are
 * noise in a chat message. A function rather than a regular expression: control characters in a pattern are a lint error.
 */
function hasForbiddenControls(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f)
      return true
  }
  return false
}
const HAS_VISIBLE_CHAR = /[^\s​-‍⁠﻿]/u

export const conversationDescriptionSchema = z
  .string()
  .trim()
  .max(LIMITS.conversationDescriptionMaxLength * 2)
  .refine((text) => codePointCount(text) <= LIMITS.conversationDescriptionMaxLength, {
    message: `At most ${LIMITS.conversationDescriptionMaxLength} characters`,
  })
  .refine((text) => !hasForbiddenControls(text), { message: 'Contains control characters' })

/** Markdown text of a user message: 1 to 5000 code points, something visible, no control characters (docs/01 section 4.5). */
export const messageBodySchema = z
  .string()
  .max(LIMITS.messageMaxCodePoints * 2)
  .refine((text) => HAS_VISIBLE_CHAR.test(text), { message: 'Message is empty' })
  .refine((text) => codePointCount(text) <= LIMITS.messageMaxCodePoints, {
    message: `At most ${LIMITS.messageMaxCodePoints} characters`,
  })
  .refine((text) => !hasForbiddenControls(text), { message: 'Contains control characters' })

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
