import type { DeletionOperation } from '@chatapp/contracts'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  forgetAccountDeletion,
  observeAccountDeletion,
  pendingAccountDeletion,
  rememberAccountDeletion,
} from './account-deletion.ts'

const operation: DeletionOperation = {
  operationId: '68e7a9cc-35a9-4bdb-b49d-5682c4b18986',
  statusUrl: '/api/deletion-operations/68e7a9cc-35a9-4bdb-b49d-5682c4b18986',
  status: 'pending',
  version: 1,
  errorCode: null,
}
const aliceId = 'fb53dc8f-1e87-48dd-99e9-94c088941b9f'
beforeEach(() => {
  forgetAccountDeletion()
  vi.useFakeTimers()
})
afterEach(() => {
  forgetAccountDeletion()
  vi.useRealTimers()
})
function setup() {
  rememberAccountDeletion(aliceId, operation)
  const pending = pendingAccountDeletion(aliceId)
  if (!pending) throw new Error('fixture missing')
  return pending
}

test('the revoked account can confirm its own completion on the anonymous page without treating a transient failure or another operation as success', async () => {
  const record = setup(),
    completed = vi.fn(),
    read = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient outage'))
      .mockResolvedValueOnce({
        ...operation,
        operationId: crypto.randomUUID(),
        status: 'completed',
        version: 3,
      })
      .mockResolvedValueOnce({ ...operation, status: 'completed', version: 3 })
  const result = observeAccountDeletion(record, {
    signal: new AbortController().signal,
    current: () => true,
    read,
    completed,
  })
  await vi.advanceTimersByTimeAsync(4000)
  expect(completed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2000)
  await result
  expect(completed).toHaveBeenCalledTimes(1)
  expect(pendingAccountDeletion()).toBeNull()
})

test('a reload restores only this tab locator, preserves the version and original expiry, and completion clears it', async () => {
  const original = setup()
  await vi.advanceTimersByTimeAsync(4000)
  vi.resetModules()
  const reloaded = await import('./account-deletion.ts')
  const record = reloaded.pendingAccountDeletion(aliceId)
  expect(record).toEqual(original)
  if (!record) throw new Error('reload lost locator')
  expect(reloaded.pendingAccountDeletion(crypto.randomUUID())).toBeNull()
  const completed = vi.fn()
  const result = reloaded.observeAccountDeletion(record, {
    signal: new AbortController().signal,
    current: () => true,
    read: vi.fn().mockResolvedValue({ ...operation, status: 'completed', version: 3 }),
    completed,
  })
  await vi.advanceTimersByTimeAsync(2000)
  await result
  expect(completed).toHaveBeenCalledOnce()
  vi.resetModules()
  expect((await import('./account-deletion.ts')).pendingAccountDeletion()).toBeNull()
})

test('malformed, mismatched, expired, completed or extended persisted locators cannot start an anonymous query', async () => {
  const valid = setup()
  forgetAccountDeletion()
  for (const stored of [
    'not-json',
    JSON.stringify({ ...valid, operation: { ...operation, status: 'completed' } }),
    JSON.stringify({
      ...valid,
      operation: { ...operation, statusUrl: '/api/deletion-operations/other' },
    }),
    JSON.stringify({ ...valid, expiresAt: Date.now() - 1 }),
    JSON.stringify({ ...valid, expiresAt: Date.now() + 10 * 60_000 + 1 }),
    JSON.stringify({ ...valid, secret: 'must-not-be-stored' }),
  ]) {
    sessionStorage.setItem('chatapp.account-deletion-status', stored)
    vi.resetModules()
    expect((await import('./account-deletion.ts')).pendingAccountDeletion()).toBeNull()
    expect(sessionStorage.getItem('chatapp.account-deletion-status')).toBeNull()
  }
})
test('a new login or generation change during a status read suppresses the old completion', async () => {
  const record = setup(),
    completed = vi.fn()
  let finish!: (value: DeletionOperation) => void,
    current = true
  const read = vi.fn(
    () =>
      new Promise<DeletionOperation>((resolve) => {
        finish = resolve
      }),
  )
  const result = observeAccountDeletion(record, {
    signal: new AbortController().signal,
    current: () => current,
    read,
    completed,
  })
  await vi.advanceTimersByTimeAsync(2000)
  current = false
  forgetAccountDeletion()
  finish({ ...operation, status: 'completed', version: 3 })
  await result
  expect(completed).not.toHaveBeenCalled()
})
test('unmount cancels the delay, and a receipt expiry or a different account cannot keep querying', async () => {
  const record = setup(),
    controller = new AbortController(),
    read = vi.fn(),
    completed = vi.fn()
  const result = observeAccountDeletion(record, {
    signal: controller.signal,
    current: () => true,
    read,
    completed,
  })
  controller.abort()
  await result
  expect(read).not.toHaveBeenCalled()
  expect(pendingAccountDeletion('bob')).toBeNull()
  await vi.advanceTimersByTimeAsync(10 * 60_000 + 1)
  expect(pendingAccountDeletion()).toBeNull()
})
