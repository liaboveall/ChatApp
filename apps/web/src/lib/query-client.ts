import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api.ts'

/** Retry transient failures only: a 4xx is an answer, not an accident. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false
  if (error instanceof ApiError) return error.code === 'NETWORK' || error.status >= 500
  return false
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: shouldRetry,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  })
}

export const queryClient = createQueryClient()
