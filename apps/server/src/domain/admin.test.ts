import { describe, expect, test } from 'bun:test'
import { checkAccountFields, checkAccountPassword } from './admin.ts'

const product = { name: 'ChatApp', agentDisplayName: '助手', agentUsername: 'assistant' }
const typed = { email: 'Someone@Example.com', username: 'someone', displayName: '  Some One  ' }

function problemOf(overrides: Partial<typeof typed>) {
  const result = checkAccountFields(product, { ...typed, ...overrides })
  return result.ok ? undefined : result.problem
}

describe('checkAccountFields (what `admin:create` accepts)', () => {
  test('returns the normalized values that will be stored', () => {
    expect(checkAccountFields(product, typed)).toEqual({
      ok: true,
      value: { email: 'someone@example.com', username: 'someone', displayName: 'Some One' },
    })
  })

  test('an upper-case username is refused with the rule, before any password is asked for', () => {
    expect(problemOf({ username: 'God' })).toEqual({
      field: 'username',
      reason: 'Only lower-case letters, digits and underscores',
    })
  })

  test('usernames outside 3 to 20 characters or with other symbols are refused', () => {
    for (const username of ['ab', 'a'.repeat(21), 'with-hyphen', 'with space', 'dot.ted']) {
      expect(problemOf({ username })?.field).toBe('username')
    }
  })

  test('a malformed email and an unusable display name name their field', () => {
    expect(problemOf({ email: 'not-an-email' })?.field).toBe('email')
    expect(problemOf({ displayName: '   ' })?.field).toBe('name')
    expect(problemOf({ displayName: `bell${String.fromCharCode(7)}name` })?.field).toBe('name')
    expect(problemOf({ displayName: 'x'.repeat(33) })?.field).toBe('name')
  })

  test('reserved usernames and display names are refused, including the configured ones', () => {
    for (const username of ['admin', 'root', 'assistant', 'chatapp']) {
      expect(problemOf({ username })).toEqual({
        field: 'username',
        reason: 'this name is reserved',
      })
    }
    for (const displayName of ['助手', 'System', ' admin ']) {
      expect(problemOf({ displayName })).toEqual({ field: 'name', reason: 'this name is reserved' })
    }
  })

  test('a problem never repeats what was typed', () => {
    const typedValue = 'Hunter2-Not-A-Name!'
    for (const overrides of [
      { username: typedValue },
      { email: typedValue },
      { displayName: typedValue.repeat(3) },
    ]) {
      expect(JSON.stringify(problemOf(overrides))).not.toContain('Hunter2')
    }
  })
})

describe('checkAccountPassword', () => {
  const identity = { email: 'ops-person42@example.com', username: 'god', displayName: 'God' }

  test('names the rule that was broken', () => {
    expect(checkAccountPassword(product, identity, 'short1')).toBe('too_short')
    expect(checkAccountPassword(product, identity, 'password123')).toBe('too_common')
    expect(checkAccountPassword(product, identity, 'aaaaaaaaaaaaaa')).toBe('too_simple')
  })

  test('a password built from the email name or the product name is refused', () => {
    expect(checkAccountPassword(product, identity, 'ops-person42-Harbor-77')).toBe(
      'contains_identity',
    )
    expect(checkAccountPassword(product, identity, 'my-chatapp-passphrase-9')).toBe(
      'contains_identity',
    )
  })

  test('a long unrelated passphrase is accepted', () => {
    expect(checkAccountPassword(product, identity, 'violet-harbor-91-compass')).toBeNull()
  })
})
