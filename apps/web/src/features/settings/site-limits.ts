import { clientSiteLimitsSchema, SITE_LIMIT_DEFAULTS } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api.ts'
import { useSyncScope } from '@/lib/sync/hooks.ts'

/** Account-scoped reads are cancelled by api() on logout; stale responses cannot install another session's policy. */
export function useSiteLimits() {
  const scope = useSyncScope()
  const query = useQuery({
    queryKey: ['site-limits', scope?.userId, scope?.authEpoch, scope?.restoreEpoch],
    enabled: scope !== null,
    queryFn: ({ signal }) => api('/api/site-limits', { schema: clientSiteLimitsSchema, signal }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  })
  return query.data ?? SITE_LIMIT_DEFAULTS
}
