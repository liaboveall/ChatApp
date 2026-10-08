import '@/lib/zod-config.ts'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { realtime } from '@/app/realtime.ts'
import { createAppRouter } from '@/app/router.ts'
import { engine, onConversationForgotten } from '@/app/sync.ts'
import { Toasts } from '@/components/ui/toasts.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { startAppearance, useAppearance } from '@/lib/appearance.ts'
import { meQuery } from '@/lib/queries.ts'
import { queryClient } from '@/lib/query-client.ts'
import { startSession } from '@/lib/session.ts'
import { setRemindersLabel } from '@/lib/sync/selectors.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { getLocale } from '@/paraglide/runtime.js'
import './styles/app.css'

document.documentElement.lang = getLocale()
setRemindersLabel(m.conversation_reminders())
startAppearance()

const router = createAppRouter(queryClient)

startSession({
  queryClient,
  stopRealtime: () => realtime.stop(),
  resetClientState: () => engine.stop(),
  toSignIn: (reason) => void router.navigate({ to: '/login', search: { reason }, replace: true }),
  // Another tab signed in: the cached "nobody" is stale. Ask again, then let the route guards decide anew.
  onSignedInElsewhere: () =>
    void queryClient
      .fetchQuery({ ...meQuery, staleTime: 0 })
      .then(() => router.invalidate())
      .catch(() => undefined),
})

// A conversation left the cache (I left, was removed, or lost access): if it is the one on screen, go home and say why.
onConversationForgotten((conversationId, reason) => {
  if (router.state.location.pathname !== `/c/${conversationId}`) return
  void router.navigate({ to: '/', replace: true })
  showToast(
    reason === 'left'
      ? m.conversation_gone_left()
      : reason === 'removed'
        ? m.conversation_gone_removed()
        : m.conversation_gone_no_access(),
  )
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
