import '@/lib/zod-config.ts'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { realtime } from '@/app/realtime.ts'
import { createAppRouter } from '@/app/router.ts'
import { Toasts } from '@/components/ui/toasts.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { startAppearance, useAppearance } from '@/lib/appearance.ts'
import { meQuery } from '@/lib/queries.ts'
import { queryClient } from '@/lib/query-client.ts'
import { startSession } from '@/lib/session.ts'
import { getLocale } from '@/paraglide/runtime.js'
import './styles/app.css'

document.documentElement.lang = getLocale()
startAppearance()

const router = createAppRouter(queryClient)

startSession({
  queryClient,
  stopRealtime: () => realtime.stop(),
  toSignIn: (reason) => void router.navigate({ to: '/login', search: { reason }, replace: true }),
  // Another tab signed in: the cached "nobody" is stale. Ask again, then let the route guards decide anew.
  onSignedInElsewhere: () =>
    void queryClient
      .fetchQuery({ ...meQuery, staleTime: 0 })
      .then(() => router.invalidate())
      .catch(() => undefined),
})

function Root() {
  const reduceMotion = useAppearance((state) => state.reduceMotion)
  return (
    // Base UI must not inject <style> elements: the page's CSP forbids them (docs/07 SEC-06).
    <CSPProvider disableStyleElements>
      <QueryClientProvider client={queryClient}>
        <MotionConfig reducedMotion={reduceMotion ? 'always' : 'user'}>
          <TooltipProvider delay={400} closeDelay={80}>
            <RouterProvider router={router} />
            <Toasts />
          </TooltipProvider>
        </MotionConfig>
      </QueryClientProvider>
    </CSPProvider>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('missing #root')
createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
