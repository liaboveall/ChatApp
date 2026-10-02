import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Welcome } from '@/features/shell/welcome.tsx'
import { usePageTitle } from '@/lib/page-title.ts'
import { meQuery } from '@/lib/queries.ts'

export const Route = createFileRoute('/_app/')({ component: WelcomeRoute })

function WelcomeRoute() {
  const { me: fromGuard } = Route.useRouteContext()
  const { data } = useQuery(meQuery)
  usePageTitle(undefined)
  return <Welcome name={(data ?? fromGuard).displayName} />
}
