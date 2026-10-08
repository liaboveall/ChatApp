import { beforeEach, expect, test, vi } from 'vitest'
import { ApiError, api } from '@/lib/api.ts'
import { clearClientStores } from '@/lib/sync/stores.ts'
import { loadRun } from './api.ts'
import { useAgent } from './store.ts'

const state = vi.hoisted(() => ({ generation: 1 }))
vi.mock('@/app/sync.ts', () => ({
  engine: {},
  forScreen: async <T>(
    _id: string | null,
    request: () => Promise<T>,
    take?: (answer: T) => void,
  ) => {
    const generation = state.generation
    const answer = await request()
    if (generation !== state.generation) return null
    take?.(answer)
    return answer
  },
}))
vi.mock('@/lib/api.ts', async (original) => ({
  ...(await original<typeof import('@/lib/api.ts')>()),
  api: vi.fn(),
}))
beforeEach(() => {
  vi.clearAllMocks()
  state.generation = 1
  clearClientStores()
})

test('an old account 404 cannot repopulate the cleared run store', async () => {
  let reject: (error: unknown) => void = () => {
    throw new Error('missing request')
  }
  const response = new Promise<never>((_resolve, fail) => {
    reject = fail
  })
  vi.mocked(api).mockReturnValueOnce(response)
  const pending = loadRun('old-run', 'old-conversation')
  state.generation++
  clearClientStores()
  reject(new ApiError(404, 'NOT_FOUND'))
  await pending
  expect(useAgent.getState().details).toEqual({})
})
test('a current owner-only 404 stops subsequent detail polling', async () => {
  vi.mocked(api).mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND'))
  await loadRun('shared-run', 'current-conversation')
  expect(useAgent.getState().details['shared-run']).toBe('denied')
})
