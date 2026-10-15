import { createFileRoute } from '@tanstack/react-router'
import { PrivacyPage } from '@/features/privacy/privacy-page.tsx'
import { usePageTitle } from '@/lib/page-title.ts'
import { m } from '@/paraglide/messages.js'
export const Route = createFileRoute('/_public/privacy')({ component: Page })
function Page() {
  usePageTitle(m.privacy_title())
  return <PrivacyPage />
}
