import { afterEach, expect, test, vi } from 'vitest'
import { ApiError, api } from '@/lib/api.ts'
import { attachmentHint } from '@/lib/sync/upload-hints.ts'
import { uploadFile } from './upload.ts'

vi.mock('@/app/sync.ts', () => ({
  engine: { ticket: vi.fn(() => ({})), isCurrent: vi.fn(() => true) },
  forScreen: vi.fn((_scope, run: () => Promise<unknown>) => run()),
}))
vi.mock('@/lib/api.ts', async (original) => ({
  ...(await original<typeof import('@/lib/api.ts')>()),
  api: vi.fn(),
}))
const reservation = { uploadId: 'u', attachmentId: 'a', status: 'uploading', attachment: null }
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})
test('long processing backs off; WS hints wake a read and a 429 respects Retry-After', async () => {
  vi.useFakeTimers()
  const request = vi.mocked(api)
  request
    .mockResolvedValueOnce(reservation)
    .mockResolvedValueOnce({ ...reservation, status: 'processing' })
    .mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', { retryAfterSeconds: 20 }))
    .mockResolvedValueOnce({ ...reservation, status: 'processing' })
    .mockResolvedValueOnce({ ...reservation, status: 'ready', attachment: { id: 'a' } })
  const pending = uploadFile(
    new Blob(['x']),
    { purpose: 'message', name: 'x', conversationId: 'c' },
    new AbortController().signal,
    vi.fn(),
  )
  await vi.advanceTimersByTimeAsync(1000)
  expect(request).toHaveBeenCalledTimes(3)
  attachmentHint('a')
  await vi.advanceTimersByTimeAsync(19_999)
  expect(request).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledTimes(4)
  attachmentHint('other')
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledTimes(4)
  attachmentHint('a')
  await expect(pending).resolves.toEqual({ id: 'a' })
})
test('abort cancels a processing wait without sending another status request', async () => {
  vi.useFakeTimers()
  vi.mocked(api)
    .mockResolvedValueOnce(reservation)
    .mockResolvedValueOnce({ ...reservation, status: 'processing' })
  const controller = new AbortController()
  const pending = uploadFile(
    new Blob(['x']),
    { purpose: 'message', name: 'x' },
    controller.signal,
    vi.fn(),
  )
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await rejected
  await vi.advanceTimersByTimeAsync(10_000)
  expect(api).toHaveBeenCalledTimes(2)
})
