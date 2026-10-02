import { describe, expect, test } from 'bun:test'
import { checkPassword } from './password-policy.ts'

describe('checkPassword', () => {
  test('enforces the length bounds first', () => {
    expect(checkPassword('short')).toBe('too_short')
    expect(checkPassword('x'.repeat(129))).toBe('too_long')
  })

  test('rejects entries of the common-password list, ignoring case', () => {
    expect(checkPassword('1234567890')).toBe('too_common')
    expect(checkPassword('Qwertyuiop')).toBe('too_common')
    expect(checkPassword('basketball')).toBe('too_common')
  })

  test('rejects repeated and sequential values', () => {
    expect(checkPassword('zzzzzzzzzzzzzz')).toBe('too_simple')
    expect(checkPassword('bcdefghijklmno')).toBe('too_simple')
    expect(checkPassword('1212121212ab')).toBe('too_simple')
  })

  test('rejects passwords that contain the account identity', () => {
    const context = {
      email: 'wangxiaoming@example.com',
      username: 'xiaoming',
      productName: 'ChatApp',
    }
    expect(checkPassword('Wangxiaoming#2026!', context)).toBe('contains_identity')
    expect(checkPassword('my-xiaoming-secret', context)).toBe('contains_identity')
    expect(checkPassword('chatapp-is-fun-99', context)).toBe('contains_identity')
  })

  test('accepts a reasonable passphrase', () => {
    expect(checkPassword('correct horse battery staple', { username: 'alice' })).toBeNull()
    expect(checkPassword('t7#Qm9vL2xPz', { email: 'alice@example.com' })).toBeNull()
  })
})
