import { createFileRoute } from '@tanstack/react-router'
import { RegisterPage } from '@/features/auth/register-page.tsx'
import { usePageTitle } from '@/lib/page-title.ts'
import { m } from '@/paraglide/messages.js'

export const Route = createFileRoute('/_guest/register')({ component: RegisterRoute })

function RegisterRoute() {
  usePageTitle(m.register_page_title())
  return <RegisterPage />
}
