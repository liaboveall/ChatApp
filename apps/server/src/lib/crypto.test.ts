import { expect, test } from 'bun:test'
import { CHATAPP_UUID_NAMESPACE, fingerprint, uuidV5 } from './crypto.ts'

test('version 5 ids match the RFC 4122 reference and are stable per name', () => {
  // The DNS namespace example from RFC 4122 / RFC 9562.
  expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
    '2ed6657d-e927-568b-95e1-2665a8aea6a2',
  )
  const id = uuidV5('run:step-3')
  expect(id).toBe(uuidV5('run:step-3', CHATAPP_UUID_NAMESPACE))
  expect(id).not.toBe(uuidV5('run:step-4'))
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(() => uuidV5('x', 'not-a-uuid')).toThrow()
})

test('request fingerprints ignore key order and absent fields, not values', () => {
  expect(fingerprint({ a: 1, b: [1, 2], c: undefined })).toBe(fingerprint({ b: [1, 2], a: 1 }))
  expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
})
