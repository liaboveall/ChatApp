import { createFileRoute, redirect } from '@tanstack/react-router'
import { AdminPage } from '@/features/admin/admin-page.tsx'
import { usePageTitle } from '@/lib/page-title.ts'
import { meQuery } from '@/lib/queries.ts'
import { m } from '@/paraglide/messages.js'
export const Route = createFileRoute('/_app/admin')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery({ ...meQuery, staleTime: 0 })
    if (me?.role !== 'admin') throw redirect({ to: '/' })
  },
  component: Page,
})
function Page() {
  usePageTitle(m.admin_title())
  return <AdminPage />
}
