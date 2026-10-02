import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { AuthLayout } from '@/features/auth/auth-layout.tsx'
import { meQuery } from '@/lib/queries.ts'
import { safeRedirect } from '@/lib/redirect.ts'

/** Pages for people who are not signed in: someone who already is goes straight to the app. */
export const Route = createFileRoute('/_guest')({
  validateSearch: z.object({ redirect: z.string().optional().catch(undefined) }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQuery)
    if (me) throw redirect({ href: safeRedirect(search.redirect) ?? '/' })
  },
  component: GuestLayout,
})

function GuestLayout() {
  return (
    <AuthLayout>
      <Outlet />
    </AuthLayout>
  )
}
