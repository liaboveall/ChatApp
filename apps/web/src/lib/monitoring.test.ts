import { expect, test } from 'vitest'
import { sanitizedError } from './monitoring.ts'

test('browser diagnostics erase names, raw text, stack values and resource identifiers', () => {
  const error = new Error('private body, email and API key')
  error.name = 'credential-value'
  error.stack = 'private frames https://secret.example/token'
  expect(sanitizedError(error, '/c/private-conversation?token=secret')).toEqual({
    kind: 'Error',
    page: 'chat',
  })
  expect(sanitizedError(new TypeError('secret'), '/login')).toEqual({
    kind: 'TypeError',
    page: 'auth',
  })
  expect(sanitizedError({ message: 'private data' }, '/arbitrary/private/path')).toEqual({
    kind: 'Error',
    page: 'unknown',
  })
})
