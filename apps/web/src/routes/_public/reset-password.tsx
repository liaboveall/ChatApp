import { createFileRoute } from '@tanstack/react-router'
import { ResetPasswordPage } from '@/features/auth/reset-password-page.tsx'
import { usePageTitle } from '@/lib/page-title.ts'
import { m } from '@/paraglide/messages.js'

export const Route = createFileRoute('/_public/reset-password')({ component: ResetRoute })

function ResetRoute() {
  usePageTitle(m.reset_page_title())
  return <ResetPasswordPage />
}
