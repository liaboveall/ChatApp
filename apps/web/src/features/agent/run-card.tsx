import { errorCodeSchema, type Message } from '@chatapp/contracts'
import { RotateCcw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { loadRun, regenerateRun, stopRun } from './api.ts'
import { useAgent } from './store.ts'

export function AgentRunCard({ message }: { message: Message }) {
  const runId = message.meta.agent?.runId
  const detail = useAgent((s) => (runId ? s.details[runId] : undefined))
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
  return (
    <div className="agent-run-card">
      {active ? (
        <small role="status">
          {detail && detail !== 'denied' && detail.run.status === 'queued'
            ? m.agent_queued()
            : m.agent_running()}
        </small>
      ) : message.status === 'failed' ? (
        <small role="status">
          {detail && detail !== 'denied' && detail.run.status === 'cancelled'
            ? m.agent_cancelled()
            : failure}
        </small>
      ) : null}
      {message.meta.agent?.truncated ? <small>{m.agent_truncated()}</small> : null}
      {detail && detail !== 'denied' ? (
        <>
          <div className="agent-controls">
            <Button
              kind="plain"
              size="sm"
              busy={busy}
              icon={active ? Square : RotateCcw}
              onClick={() => void action(active ? 'stop' : 'regenerate')}
            >
              {active ? m.agent_stop() : m.agent_regenerate()}
            </Button>
            <small>
              {detail.run.usage.inputTokens + detail.run.usage.outputTokens} tokens · $
              {detail.run.usage.costUsd}
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
