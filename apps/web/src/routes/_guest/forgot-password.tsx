import { createFileRoute } from '@tanstack/react-router'
import { ForgotPasswordPage } from '@/features/auth/forgot-password-page.tsx'
import { usePageTitle } from '@/lib/page-title.ts'
import { m } from '@/paraglide/messages.js'

export const Route = createFileRoute('/_guest/forgot-password')({ component: ForgotRoute })

function ForgotRoute() {
  usePageTitle(m.forgot_page_title())
  return <ForgotPasswordPage />
}
