import type { DeletionOperation } from '@chatapp/contracts'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api } from '@/lib/api.ts'
import type { RequestTicket } from '@/lib/sync/types.ts'
import { showToast } from '@/lib/toast.ts'
import { waitForDeletion } from './wait.ts'

const state = vi.hoisted(() => ({ current: true }))
vi.mock('@/app/sync.ts', () => ({ engine: { isCurrent: () => state.current } }))
vi.mock('@/lib/api.ts', () => ({ api: vi.fn() }))
vi.mock('@/lib/toast.ts', () => ({ showToast: vi.fn() }))
vi.mock('@/paraglide/messages.js', () => ({
  m: { deletion_pending: () => 'pending', deletion_completed: () => 'completed' },
}))
const ticket = {} as RequestTicket
const pending: DeletionOperation = {
  operationId: '68e7a9cc-35a9-4bdb-b49d-5682c4b18986',
  status: 'pending',
  statusUrl: '/api/deletion-operations/68e7a9cc-35a9-4bdb-b49d-5682c4b18986',
  version: 1,
  errorCode: null,
}
beforeEach(() => {
  state.current = true
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

test('pending remains pending until a successful status read, with no deletion resubmission', async () => {
  vi.mocked(api)
    .mockRejectedValueOnce(new Error('temporary outage'))
    .mockResolvedValueOnce({ ...pending, status: 'completed', version: 3 })
  const result = waitForDeletion(pending, ticket)
  expect(showToast).toHaveBeenCalledWith('pending')
  expect(showToast).not.toHaveBeenCalledWith('completed')
  await vi.advanceTimersByTimeAsync(4000)
  expect(await result).toBe(true)
  expect(api).toHaveBeenCalledTimes(2)
  expect(api).toHaveBeenCalledWith(
    pending.statusUrl,
    expect.objectContaining({ schema: expect.anything() }),
  )
  expect(showToast).toHaveBeenLastCalledWith('completed')
})
test('switching account or conversation while a status read is pending suppresses completion feedback', async () => {
  let finish!: (value: DeletionOperation) => void
  vi.mocked(api).mockReturnValueOnce(
    new Promise<DeletionOperation>((resolve) => {
      finish = resolve
    }),
  )
  const result = waitForDeletion(pending, ticket)
  await vi.advanceTimersByTimeAsync(2000)
  state.current = false
  finish({ ...pending, status: 'completed', version: 3 })
  expect(await result).toBe(false)
  expect(showToast).not.toHaveBeenCalledWith('completed')
})
test('a switch during the delay stops all subsequent status reads', async () => {
  const result = waitForDeletion(pending, ticket)
  state.current = false
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toBe(false)
  expect(api).not.toHaveBeenCalled()
})
test('an old ticket cannot show even an already completed deletion as success', async () => {
  state.current = false
  expect(await waitForDeletion({ ...pending, status: 'completed' }, ticket)).toBe(false)
  expect(showToast).not.toHaveBeenCalled()
})
test('unmounting a resumed status view cancels its delay without querying or announcing completion', async () => {
  const controller = new AbortController()
  const result = waitForDeletion(pending, ticket, { signal: controller.signal })
  controller.abort()
  expect(await result).toBe(false)
  expect(api).not.toHaveBeenCalled()
  expect(showToast).not.toHaveBeenCalledWith('completed')
})
test('a modal with inline pending feedback raises no duplicate pending toast and still announces confirmed completion', async () => {
  vi.mocked(api).mockResolvedValueOnce({ ...pending, status: 'completed', version: 3 })
  const result = waitForDeletion(pending, ticket, { pendingToast: false })
  expect(showToast).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toBe(true)
  expect(showToast).toHaveBeenCalledExactlyOnceWith('completed')
})
test('a different operation or an older status version cannot announce completion', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({
      ...pending,
      operationId: crypto.randomUUID(),
      status: 'completed',
      version: 3,
    })
    .mockResolvedValueOnce({ ...pending, status: 'pending', version: 2 })
    .mockResolvedValueOnce({ ...pending, status: 'completed', version: 1 })
    .mockResolvedValueOnce({ ...pending, status: 'completed', version: 3 })
  const result = waitForDeletion(pending, ticket)
  await vi.advanceTimersByTimeAsync(6000)
  expect(showToast).not.toHaveBeenCalledWith('completed')
  await vi.advanceTimersByTimeAsync(2000)
  expect(await result).toBe(true)
})
