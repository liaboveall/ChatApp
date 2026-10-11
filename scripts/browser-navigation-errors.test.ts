import { expect, test } from 'bun:test'
import { isWebKitReloadCancellation } from '../apps/web/e2e/support/navigation-errors.ts'

const cancellation = (url = 'http://localhost:4173/api/notifications?limit=30') =>
  `Fetch API cannot load ${url} due to access control checks.\n    at fetch (app.js:1:1)`
const oldDocument = {
  engine: 'webkit',
  origin: 'http://localhost:4173',
  stack: cancellation(),
  at: 125,
  reloads: [{ from: 100, committed: 150 }],
}

test('an expected old-document cancellation is confined to the explicit WebKit reload before commit', () => {
  expect(isWebKitReloadCancellation(oldDocument)).toBe(true)
  expect(
    isWebKitReloadCancellation({ ...oldDocument, reloads: [{ from: 100, committed: null }] }),
  ).toBe(true)
})

test('an access-control error on a live page is still a failure', () => {
  expect(isWebKitReloadCancellation({ ...oldDocument, reloads: [] })).toBe(false)
  expect(isWebKitReloadCancellation({ ...oldDocument, at: 99 })).toBe(false)
})

test('the newly committed document is never covered by the old document cancellation', () => {
  expect(isWebKitReloadCancellation({ ...oldDocument, at: 150 })).toBe(false)
  expect(isWebKitReloadCancellation({ ...oldDocument, at: 151 })).toBe(false)
})

test('other engines, origins and non-API resources keep the normal error check', () => {
  expect(isWebKitReloadCancellation({ ...oldDocument, engine: 'chromium' })).toBe(false)
  expect(isWebKitReloadCancellation({ ...oldDocument, engine: 'firefox' })).toBe(false)
  expect(
    isWebKitReloadCancellation({
      ...oldDocument,
      stack: cancellation('https://other.example/api/notifications'),
    }),
  ).toBe(false)
  expect(
    isWebKitReloadCancellation({
      ...oldDocument,
      stack: cancellation('http://localhost:4173/assets/app.js'),
    }),
  ).toBe(false)
})

test('application exceptions and a message without the native stack signature remain failures', () => {
  expect(isWebKitReloadCancellation({ ...oldDocument, stack: `Error: ${cancellation()}` })).toBe(
    false,
  )
  expect(isWebKitReloadCancellation({ ...oldDocument, stack: undefined })).toBe(false)
  expect(isWebKitReloadCancellation({ ...oldDocument, stack: 'TypeError: Failed to fetch' })).toBe(
    false,
  )
})
