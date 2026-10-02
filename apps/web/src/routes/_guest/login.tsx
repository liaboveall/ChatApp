import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { LoginPage } from '@/features/auth/login-page.tsx'
import { usePageTitle } from '@/lib/page-title.ts'
import { safeRedirect } from '@/lib/redirect.ts'
import { m } from '@/paraglide/messages.js'

export const Route = createFileRoute('/_guest/login')({
  validateSearch: z.object({
    redirect: z.string().optional().catch(undefined),
    reason: z
      .enum(['signed-out', 'expired', 'ended-elsewhere', 'password-changed'])
      .optional()
      .catch(undefined),
  }),
  component: LoginRoute,
})

function LoginRoute() {
  const { redirect, reason } = Route.useSearch()
  usePageTitle(m.login_page_title())
  return <LoginPage redirectTo={safeRedirect(redirect)} reason={reason} />
}
