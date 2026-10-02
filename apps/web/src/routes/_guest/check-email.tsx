import { createFileRoute } from '@tanstack/react-router'
import { CheckEmailPage } from '@/features/auth/verify-email-page.tsx'
import { usePageTitle } from '@/lib/page-title.ts'
import { m } from '@/paraglide/messages.js'

export const Route = createFileRoute('/_guest/check-email')({ component: CheckEmailRoute })

function CheckEmailRoute() {
  usePageTitle(m.verify_sent_title())
  return <CheckEmailPage />
}
