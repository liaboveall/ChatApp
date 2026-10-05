import type { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { Splash } from '@/features/shell/route-states.tsx'
import { routeTree } from '../routeTree.gen.ts'

export type RouterContext = { queryClient: QueryClient }

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPendingMs: 250,
    defaultPendingComponent: Splash,
    scrollRestoration: true,
  })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
  interface StaticDataRouteOption {
    /** `fill`: the screen fills the main panel and scrolls inside itself (the conversation). */
    layout?: 'fill'
  }
  interface HistoryState {
    /** The address a verification email was sent to (kept in the tab's history entry, never in the URL). */
    email?: string
  }
}
