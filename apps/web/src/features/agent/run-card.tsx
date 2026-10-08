import { errorCodeSchema, type Message } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { RotateCcw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { meQuery } from '@/lib/queries.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { loadRun, regenerateRun, stopRun, switchKeySource } from './api.ts'
import { ApprovalCard } from './approval-card.tsx'
import { useAgent } from './store.ts'

export function AgentRunCard({
  message,
  nameOf,
}: {
  message: Message
  /** Display name of a member, for "waiting for <name> to approve" in shared conversations. */
  nameOf?: (userId: string) => string | undefined
}) {
  const runId = message.meta.agent?.runId
  const detail = useAgent((s) => (runId ? s.details[runId] : undefined))
  const { data: me } = useQuery(meQuery)
  const [busy, setBusy] = useState(false)
  const denied = detail === 'denied'
  const code = detail && detail !== 'denied' ? detail.run.error?.code : undefined
  const knownCode = errorCodeSchema.safeParse(code)
  const failure =
    code === 'UNKNOWN_EXECUTION' || code === 'CALL_OUTCOME_UNKNOWN'
      ? m.agent_unknown_execution()
      : knownCode.success
        ? describeError(new ApiError(400, knownCode.data))
        : m.agent_failed()
  const active =
    detail && detail !== 'denied'
      ? ['queued', 'running'].includes(detail.run.status)
      : message.status === 'streaming'
  const waitingFor = message.meta.agent?.awaitingApproval?.userId
  useEffect(() => {
    if (!runId || denied) return
    void loadRun(runId, message.conversationId)
    if (!active) return
    const timer = setInterval(() => void loadRun(runId, message.conversationId), 2000)
    return () => clearInterval(timer)
  }, [runId, message.conversationId, active, denied])
  if (!runId) return null
  const action = async (kind: 'stop' | 'regenerate') => {
    setBusy(true)
    try {
      if (kind === 'stop') await stopRun(runId, message.conversationId)
      else await regenerateRun(runId, message.conversationId)
    } catch (error) {
      showToast(describeError(error))
    } finally {
      setBusy(false)
    }
  }
  const switchToSite = async (conversationId: string) => {
    setBusy(true)
    try {
      if ((await switchKeySource(conversationId, 'site')) !== null)
        showToast(m.agent_key_switched())
    } catch (error) {
      showToast(describeError(error))
    } finally {
      setBusy(false)
    }
  }
  const run = detail && detail !== 'denied' ? detail.run : undefined
  // The requests this reply segment made; the segment after a decision is a reply of its own (D-051).
  const segment = message.meta.agent?.resumeSeq ?? 0
  const approvals =
    detail && detail !== 'denied' ? detail.approvals.filter((a) => a.resumeSeq === segment) : []
  const ownKeyRefused =
    run?.status === 'failed' &&
    code === 'AI_KEY_INVALID' &&
    run.keySource === 'user' &&
    run.trigger !== 'mention' &&
    run.conversationId !== null
  return (
    <div className="agent-run-card">
      {active ? (
        <small role="status">
          {run?.status === 'queued' ? m.agent_queued() : m.agent_running()}
        </small>
      ) : message.status === 'failed' ? (
        <small role="status">{run?.status === 'cancelled' ? m.agent_cancelled() : failure}</small>
      ) : null}
      {waitingFor && (!run || run.pendingApproval) ? (
        <small role="status" className="agent-run-card__waiting">
          {waitingFor === me?.id
            ? m.agent_waiting_you()
            : m.agent_waiting({ name: nameOf?.(waitingFor) ?? m.agent_assistant() })}
        </small>
      ) : null}
      {message.meta.agent?.truncated ? <small>{m.agent_truncated()}</small> : null}
      {run && detail && detail !== 'denied'
        ? approvals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              run={run}
              effect={detail.effects.find((e) => e.stepIndex === approval.stepIndex)}
            />
          ))
        : null}
      {ownKeyRefused && run?.conversationId ? (
        <div className="agent-run-card__key">
          <small>{m.agent_key_failed_hint()}</small>
          <Button
            kind="tinted"
            size="sm"
            busy={busy}
            onClick={() => void switchToSite(run.conversationId ?? '')}
          >
            {m.agent_key_failed_action()}
          </Button>
        </div>
      ) : null}
      {run && detail && detail !== 'denied' ? (
        <>
          <div className="agent-controls">
            {active || !(run.hasEffects || run.pendingApproval) ? (
              <Button
                kind="plain"
                size="sm"
                busy={busy}
                icon={active ? Square : RotateCcw}
                onClick={() => void action(active ? 'stop' : 'regenerate')}
              >
                {active ? m.agent_stop() : m.agent_regenerate()}
              </Button>
            ) : null}
            <small>
              {run.keySource === 'user' ? `${m.agent_key_own()} · ` : ''}
              {run.usage.inputTokens + run.usage.outputTokens} tokens · ${run.usage.costUsd}
            </small>
          </div>
          {detail.steps.length ? (
            <details>
              <summary>{m.agent_steps()}</summary>
              {detail.steps
                .filter(
                  (s) => s.type === 'tool_call' || s.type === 'tool_result' || s.type === 'error',
                )
                .map((s) => (
                  <div key={s.index}>
                    <small>{s.toolName ?? s.type}</small>
                    <pre>
                      {s.payload === null
                        ? m.quote_unavailable()
                        : JSON.stringify(s.payload, null, 2)}
                    </pre>
                  </div>
                ))}
            </details>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
