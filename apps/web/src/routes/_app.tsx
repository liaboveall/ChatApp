import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet, redirect, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { z } from 'zod'
import { realtime } from '@/app/realtime.ts'
import { useSyncLifecycle } from '@/app/use-sync-lifecycle.ts'
import { prefetchMarkdown } from '@/components/markdown/lazy.ts'
import { authApi } from '@/features/auth/auth-api.ts'
import { SETTINGS_SECTIONS } from '@/features/settings/settings-sheet.tsx'
import { useAutoTimezone } from '@/features/settings/use-auto-timezone.ts'
import { AppFrame, useRealtimeBridge } from '@/features/shell/app-frame.tsx'
import { describeError } from '@/lib/error-messages.ts'
import { meQuery } from '@/lib/queries.ts'
import { endSession, markSignedIn } from '@/lib/session.ts'
import { showToast } from '@/lib/toast.ts'

/** Everything behind the sign-in. The route guard answers from the API, never from anything the browser stored. */
export const Route = createFileRoute('/_app')({
  validateSearch: z.object({
    settings: z.enum(SETTINGS_SECTIONS).optional().catch(undefined),
  }),
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    if (!me) throw redirect({ to: '/login', search: { redirect: location.href }, replace: true })
    markSignedIn()
    return { me }
  },
  component: AppRoute,
})

async function signOut(): Promise<void> {
  try {
    await authApi.signOut()
  } catch (error) {
    // Still signed in on the server: say so instead of pretending.
    showToast(describeError(error))
    return
  }
  endSession('signed-out')
}

function AppRoute() {
  // No `from`: opening settings must stay on whatever screen is open (a conversation, a list), not go home.
  const navigate = useNavigate()
  const { me: fromGuard } = Route.useRouteContext()
  const { settings } = Route.useSearch()
  const { data } = useQuery(meQuery)
  const me = data ?? fromGuard
  // A refetch of the identity that finds nobody (a session revoked while this tab slept) ends the session here too.
  useEffect(() => {
    if (data === null) endSession('expired')
  }, [data])
  useRealtimeBridge(realtime)
  useSyncLifecycle(me)
  // The Markdown chunk is big: ask for it once the app is on screen and the browser is idle (D-145).
  useEffect(prefetchMarkdown, [])
  useAutoTimezone(me)
  return (
    <AppFrame
      me={me}
      settings={settings}
      onSettingsChange={(section) =>
        void navigate({ to: '.', search: (previous) => ({ ...previous, settings: section }) })
      }
      onSignOut={() => void signOut()}
    >
      <Outlet />
    </AppFrame>
  )
}
