import { createFileRoute } from '@tanstack/react-router'
import { VerifyEmailPage } from '@/features/auth/verify-email-page.tsx'
import { usePageTitle } from '@/lib/page-title.ts'
import { m } from '@/paraglide/messages.js'

export const Route = createFileRoute('/_public/verify-email')({ component: VerifyRoute })

function VerifyRoute() {
  usePageTitle(m.verify_page_title())
  return <VerifyEmailPage />
}
