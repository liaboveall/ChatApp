import { agentUsageSchema } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
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
  const share = (used: number, limit: number): CSSProperties =>
    ({
      '--v': `${limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0}%`,
    }) as CSSProperties
  return (
    <section className="agent-usage group" aria-label={m.agent_usage()}>
      <h3 className="group__title">{m.agent_usage()}</h3>
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
        <div className="group__box agent-usage__box">
          {/* The bars repeat the numbers beside them: decoration for the eye, the text is what is read. */}
          <div className="meter">
            <p>{m.agent_usage_tokens({ used: data.daily.settled, limit: data.daily.limit })}</p>
            <div className="meter__bar" aria-hidden="true">
              <i style={share(data.daily.settled, data.daily.limit)} />
            </div>
            <small>
              {m.agent_usage_reserved({
                reserved: data.daily.reserved,
                unknown: data.daily.unknown,
              })}
            </small>
          </div>
          <div className="meter">
            <p>
              {m.agent_usage_cost({
                used: (data.monthly.settledMicroUsd / 1_000_000).toFixed(4),
                limit: (data.monthly.limitMicroUsd / 1_000_000).toFixed(2),
              })}
            </p>
            <div className="meter__bar" aria-hidden="true">
              <i style={share(data.monthly.settledMicroUsd, data.monthly.limitMicroUsd)} />
            </div>
            <small>
              {m.agent_usage_reserved({
                reserved: (data.monthly.reservedMicroUsd / 1_000_000).toFixed(4),
                unknown: (data.monthly.unknownMicroUsd / 1_000_000).toFixed(4),
              })}
            </small>
          </div>
          {data.warning ? (
            <p role="status" className="agent-usage__alert">
              {m.agent_usage_warning()}
            </p>
          ) : null}
          {data.paused ? (
            <p role="status" className="agent-usage__alert">
              {m.agent_usage_paused()}
            </p>
          ) : null}
          <div className="agent-usage__foot">
            <small>
              {m.agent_usage_reset({
                when: new Date(data.daily.resetAt).toLocaleString(locale, { timeZone }),
              })}
            </small>
            {data.provider === 'soclaas' ? <small>{m.agent_usage_free()}</small> : null}
            <small>
              {m.agent_usage_updated({
                when: new Date(query.dataUpdatedAt).toLocaleString(locale, { timeZone }),
              })}
            </small>
          </div>
        </div>
      ) : !query.isError ? (
        <p className="agent-usage__state">
          {scope ? m.common_loading() : m.agent_usage_unavailable()}
        </p>
      ) : null}
    </section>
  )
}
