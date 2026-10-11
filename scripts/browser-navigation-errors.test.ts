import { expect, test } from 'bun:test'
import { isWebKitDocumentCancellation } from '../apps/web/e2e/support/navigation-errors.ts'

const cancellation = (url = 'http://localhost:4173/api/notifications?limit=30') =>
  `Fetch API cannot load ${url} due to access control checks.\n    at fetch (app.js:1:1)`
const oldDocument = {
  engine: 'webkit',
  origin: 'http://localhost:4173',
  stack: cancellation(),
  at: 125,
  replacements: [{ from: 100, committed: 150 }],
}

test('an expected old-document cancellation is confined to explicit WebKit document replacement before commit', () => {
  expect(isWebKitDocumentCancellation(oldDocument)).toBe(true)
  expect(
    isWebKitDocumentCancellation({
      ...oldDocument,
      replacements: [{ from: 100, committed: null }],
    }),
  ).toBe(true)
})

test('an access-control error on a live page is still a failure', () => {
  expect(isWebKitDocumentCancellation({ ...oldDocument, replacements: [] })).toBe(false)
  expect(isWebKitDocumentCancellation({ ...oldDocument, at: 99 })).toBe(false)
})

test('the newly committed document is never covered by the old document cancellation', () => {
  expect(isWebKitDocumentCancellation({ ...oldDocument, at: 150 })).toBe(false)
  expect(isWebKitDocumentCancellation({ ...oldDocument, at: 151 })).toBe(false)
})

test('other engines, origins and non-API resources keep the normal error check', () => {
  expect(isWebKitDocumentCancellation({ ...oldDocument, engine: 'chromium' })).toBe(false)
  expect(isWebKitDocumentCancellation({ ...oldDocument, engine: 'firefox' })).toBe(false)
  expect(
    isWebKitDocumentCancellation({
      ...oldDocument,
      stack: cancellation('https://other.example/api/notifications'),
    }),
  ).toBe(false)
  expect(
    isWebKitDocumentCancellation({
      ...oldDocument,
      stack: cancellation('http://localhost:4173/assets/app.js'),
    }),
  ).toBe(false)
})

test('application exceptions and a message without the native stack signature remain failures', () => {
  expect(isWebKitDocumentCancellation({ ...oldDocument, stack: `Error: ${cancellation()}` })).toBe(
    false,
  )
  expect(isWebKitDocumentCancellation({ ...oldDocument, stack: undefined })).toBe(false)
  expect(
    isWebKitDocumentCancellation({ ...oldDocument, stack: 'TypeError: Failed to fetch' }),
  ).toBe(false)
})

test('a same-document fragment move or an unconfirmed navigation still checks live-page errors', () => {
  expect(
    isWebKitDocumentCancellation({
      ...oldDocument,
      replacements: [{ from: 100, committed: 150, document: false }],
    }),
  ).toBe(false)
})
