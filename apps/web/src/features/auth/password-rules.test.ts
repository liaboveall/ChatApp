import { describe, expect, test } from 'vitest'
import { evaluatePassword, passwordAcceptable } from './password-rules.tsx'

describe('evaluatePassword', () => {
  test('nothing typed: every rule is waiting', () => {
    expect(evaluatePassword('', {})).toEqual({
      length: 'idle',
      simple: 'idle',
      identity: 'idle',
      common: 'idle',
    })
  })

  test('too short: length fails, structure is not judged yet', () => {
    const result = evaluatePassword('abc', {})
    expect(result.length).toBe('fail')
    expect(result.simple).toBe('idle')
    expect(passwordAcceptable(result)).toBe(false)
  })

  test('a long but patterned password fails the simplicity rule', () => {
    expect(evaluatePassword('aaaaaaaaaaaa', {}).simple).toBe('fail')
    expect(evaluatePassword('abcdefghijkl', {}).simple).toBe('fail')
  })

  test("the account's own names fail the identity rule, the product name too", () => {
    const context = {
      email: 'wangxiaoming@example.com',
      username: 'xiaoming',
      displayName: 'Ming Wang',
    }
    expect(evaluatePassword('my-xiaoming-secret-9', context).identity).toBe('fail')
    expect(evaluatePassword('Wangxiaoming#2026!', context).identity).toBe('fail')
    expect(evaluatePassword('my-chatapp-secret-9', context).identity).toBe('fail')
    expect(evaluatePassword('t7#Qm9vL2xPz', context).identity).toBe('pass')
  })

  test("the common-password rule is only decided by the server's answer", () => {
    expect(evaluatePassword('t7#Qm9vL2xPz', {}).common).toBe('idle')
    expect(evaluatePassword('t7#Qm9vL2xPz', {}, 'too_common').common).toBe('fail')
    expect(evaluatePassword('t7#Qm9vL2xPz', {}, 'too_simple').common).toBe('idle')
  })

  test('a good password is acceptable', () => {
    expect(
      passwordAcceptable(evaluatePassword('correct horse battery staple', { username: 'alice' })),
    ).toBe(true)
  })
})
