import { describe, expect, test } from 'bun:test'
import {
  AUTH_ENDPOINTS,
  displayNameSchema,
  emailSchema,
  findAuthEndpoint,
  formatInviteCode,
  graphemeCount,
  isReservedDisplayName,
  isReservedUsername,
  normalizeEmail,
  normalizeInviteCode,
  passwordSchema,
  signUpRequestSchema,
  usernameSchema,
} from './index.ts'

describe('identity rules', () => {
  test('usernames are 3-20 lower-case letters, digits or underscores', () => {
    for (const ok of ['abc', 'a_b_c', 'user123', 'a'.repeat(20)]) {
      expect(usernameSchema.safeParse(ok).success).toBe(true)
    }
    for (const bad of ['ab', 'a'.repeat(21), 'Abc', 'a-b', 'a b', 'ünï', '中文名字']) {
      expect(usernameSchema.safeParse(bad).success).toBe(false)
    }
  })

  test('display names count graphemes, so one emoji family is one character', () => {
    expect(graphemeCount('👨‍👩‍👧‍👦')).toBe(1)
    expect(displayNameSchema.safeParse('👨‍👩‍👧‍👦').success).toBe(true)
    expect(displayNameSchema.safeParse('张三').success).toBe(true)
    expect(displayNameSchema.safeParse('a'.repeat(32)).success).toBe(true)
    expect(displayNameSchema.safeParse('a'.repeat(33)).success).toBe(false)
    expect(displayNameSchema.safeParse('   ').success).toBe(false)
  })

  test('display names reject control, bidi and zero-width characters', () => {
    for (const bad of ['a\u202Eb', 'a\u200Bb', 'a\nb', 'a\u0000b', 'na\uFEFFme']) {
      expect(displayNameSchema.safeParse(bad).success).toBe(false)
    }
  })

  test('passwords are 10-128 characters', () => {
    expect(passwordSchema.safeParse('a'.repeat(9)).success).toBe(false)
    expect(passwordSchema.safeParse('a'.repeat(10)).success).toBe(true)
    expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false)
  })

  test('emails are validated and lower-cased for storage', () => {
    expect(emailSchema.safeParse(' A@Example.com ').success).toBe(true)
    expect(emailSchema.safeParse('not-an-email').success).toBe(false)
    expect(normalizeEmail(' A@Example.COM ')).toBe('a@example.com')
  })

  test('invite codes tolerate spaces, hyphens and case', () => {
    expect(normalizeInviteCode('abcd-efgh ijkl-MNOP')).toBe('ABCDEFGHIJKLMNOP')
    expect(normalizeInviteCode('ABCDEFGHIJKLMNO')).toBeNull()
    expect(normalizeInviteCode('ABCDEFGHIJKLMNO1')).toBeNull() // 1 is not in the base32 alphabet
    expect(formatInviteCode('ABCDEFGHIJKLMNOP')).toBe('ABCD-EFGH-IJKL-MNOP')
  })

  test('sign-up rejects unknown fields so privileged columns cannot be smuggled in', () => {
    const base = { email: 'a@b.co', username: 'abc', name: 'A', password: 'a'.repeat(10) }
    expect(signUpRequestSchema.safeParse(base).success).toBe(true)
    for (const extra of ['role', 'isBot', 'registrationId', 'emailVerified', 'activationStatus']) {
      expect(signUpRequestSchema.safeParse({ ...base, [extra]: 'admin' }).success).toBe(false)
    }
  })
})

describe('reserved names', () => {
  test('are compared after NFKC, case folding and whitespace removal', () => {
    expect(isReservedUsername('admin')).toBe(true)
    expect(isReservedUsername('ａｄｍｉｎ')).toBe(true)
    expect(isReservedDisplayName('助 手')).toBe(true)
    expect(isReservedDisplayName('ＳＹＳＴＥＭ')).toBe(true)
    expect(isReservedDisplayName('小王')).toBe(false)
  })

  test('configured names and the deleted-account prefix are reserved too', () => {
    expect(isReservedUsername('helper', ['helper'])).toBe(true)
    expect(isReservedDisplayName('小助', ['小助'])).toBe(true)
    expect(isReservedUsername('deleted_ab12cd')).toBe(true)
  })
})

describe('auth endpoint allowlist', () => {
  test('matches exact method and path only', () => {
    expect(findAuthEndpoint('POST', '/api/auth/sign-in/email')?.capability).toBe('login')
    expect(findAuthEndpoint('GET', '/api/auth/sign-in/email')).toBeUndefined()
    expect(findAuthEndpoint('POST', '/api/auth/sign-in/email/')).toBeUndefined()
    expect(findAuthEndpoint('POST', '/api/auth/Sign-In/email')).toBeUndefined()
    expect(findAuthEndpoint('POST', '/api/auth/sign-in/%65mail')).toBeUndefined()
    expect(findAuthEndpoint('POST', '/api/auth//sign-in/email')).toBeUndefined()
  })

  test('has no duplicate entries and never lists the dangerous native routes', () => {
    const keys = AUTH_ENDPOINTS.map((e) => `${e.method} ${e.path}`)
    expect(new Set(keys).size).toBe(keys.length)
    const forbidden = [
      '/api/auth/update-user',
      '/api/auth/change-email',
      '/api/auth/delete-user',
      '/api/auth/reset-password',
      '/api/auth/verify-email',
      '/api/auth/send-verification-email',
      '/api/auth/list-sessions',
      '/api/auth/get-session',
    ]
    for (const path of forbidden) {
      expect(AUTH_ENDPOINTS.some((e) => e.path === path || e.path.startsWith(`${path}/`))).toBe(
        false,
      )
    }
  })
})
