import { agentUsageSchema } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { forScreen } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { useSyncScope } from '@/lib/sync/hooks.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'

export function AgentUsage() {
  const scope = useSyncScope()
  const { locale, timeZone } = useTime()
  const query = useQuery({
    queryKey: ['agent-usage', scope?.userId, scope?.generation],
    enabled: scope !== null,
    queryFn: () => forScreen(null, () => api('/api/agent/usage', { schema: agentUsageSchema })),
    refetchInterval: 15_000,
  })
  const { data } = query
  return (
    <section className="agent-usage" aria-label={m.agent_usage()}>
      <h3>{m.agent_usage()}</h3>
      {query.isError ? (
        <Banner tone="danger">
          {describeError(query.error)}
          <Button
            size="sm"
            kind="plain"
            busy={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {m.common_retry()}
          </Button>
        </Banner>
      ) : null}
      {data ? (
        <>
          <p>{m.agent_usage_tokens({ used: data.daily.settled, limit: data.daily.limit })}</p>
          <small>
            {m.agent_usage_reserved({ reserved: data.daily.reserved, unknown: data.daily.unknown })}
          </small>
          <p>
            {m.agent_usage_cost({
              used: (data.monthly.settledMicroUsd / 1_000_000).toFixed(4),
              limit: (data.monthly.limitMicroUsd / 1_000_000).toFixed(2),
            })}
          </p>
          <small>
            {m.agent_usage_reserved({
              reserved: (data.monthly.reservedMicroUsd / 1_000_000).toFixed(4),
              unknown: (data.monthly.unknownMicroUsd / 1_000_000).toFixed(4),
            })}
          </small>
          <small>
            {m.agent_usage_reset({
              when: new Date(data.daily.resetAt).toLocaleString(locale, { timeZone }),
            })}
          </small>
          {data.provider === 'soclaas' ? <small>{m.agent_usage_free()}</small> : null}
          {data.warning ? <p role="status">{m.agent_usage_warning()}</p> : null}
          {data.paused ? <p role="status">{m.agent_usage_paused()}</p> : null}
          <small>
            {m.agent_usage_updated({
              when: new Date(query.dataUpdatedAt).toLocaleString(locale, { timeZone }),
            })}
          </small>
        </>
      ) : !query.isError ? (
        <p>{scope ? m.common_loading() : m.agent_usage_unavailable()}</p>
      ) : null}
    </section>
  )
}
