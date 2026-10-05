import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { DiscoveryPage } from '@/features/conversations/discovery-page.tsx'

/** `/channels?query=`: the discovery page; the search is part of the address so it can be shared and survives a reload. */
export const Route = createFileRoute('/_app/channels')({
  validateSearch: z.object({
    query: z.string().trim().min(1).max(64).optional().catch(undefined),
  }),
  component: ChannelsRoute,
})

function ChannelsRoute() {
  const { query } = Route.useSearch()
  const navigate = useNavigate({ from: '/channels' })
  return (
    <DiscoveryPage
      query={query ?? ''}
      onQueryChange={(next) =>
        void navigate({ search: { query: next === '' ? undefined : next }, replace: true })
      }
    />
  )
}
