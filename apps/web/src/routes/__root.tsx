import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import type { RouterContext } from '@/app/router.ts'
import { NotFound, RouteAnnouncer, RouteError } from '@/features/shell/route-states.tsx'

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RouteError,
})

function RootLayout() {
  return (
    <>
      <Outlet />
      <RouteAnnouncer />
    </>
  )
}
