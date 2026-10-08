import {
  type AgentDelta,
  type AgentRunRequest,
  agentRunDetailSchema,
  agentRunResponseSchema,
  conversationSchema,
  messageEnvelopeSchema,
  okResponseSchema,
  type WsServerMessage,
} from '@chatapp/contracts'
import { engine, forScreen } from '@/app/sync.ts'
import { ApiError, api } from '@/lib/api.ts'
import { registerStoreReset } from '@/lib/sync/stores.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { rememberRun, useAgent } from './store.ts'

export const startRun = (input: AgentRunRequest, key = crypto.randomUUID()) =>
  forScreen(
    input.contextConversationId ?? input.conversationId ?? null,
    async () => {
      const { run } = await api('/api/agent/runs', {
        method: 'POST',
        json: input,
        schema: agentRunResponseSchema,
        idempotencyKey: key,
      })
      const conversation = run.conversationId
        ? await api(`/api/conversations/${run.conversationId}`, { schema: conversationSchema })
        : null
      return { run, conversation }
    },
    ({ run, conversation }, ticket) => {
      if (conversation) engine.ingestConversation(conversation, ticket)
      rememberRun({ run, steps: [] })
    },
  )

export async function loadRun(id: string, conversationId: string | null): Promise<void> {
  try {
    await forScreen(
      conversationId,
      async () => {
        try {
          return await api(`/api/agent/runs/${id}`, { schema: agentRunDetailSchema })
        } catch (error) {
          if (error instanceof ApiError && error.code === 'NOT_FOUND') return 'denied' as const
          throw error
        }
      },
      (result) => {
        if (result === 'denied') {
          useAgent.setState((s) => ({ details: { ...s.details, [id]: 'denied' } }))
          return
        }
        const previous = useAgent.getState().details[id]
        if (!result.run.outputMessageId && result.run.status === 'failed' && !previous)
          showToast(m.agent_failed())
        rememberRun(result)
      },
    )
  } catch {}
}
export const stopRun = (id: string, conversationId: string) =>
  forScreen(
    conversationId,
    () => api(`/api/agent/runs/${id}/cancel`, { method: 'POST', schema: agentRunResponseSchema }),
    ({ run }) => rememberRun({ run, steps: [] }),
  )
export const regenerateRun = (id: string, conversationId: string) =>
  forScreen(
    conversationId,
    () =>
      api(`/api/agent/runs/${id}/regenerate`, {
        method: 'POST',
        schema: agentRunResponseSchema,
        idempotencyKey: crypto.randomUUID(),
      }),
    ({ run }) => {
      rememberRun({ run, steps: [] })
      void repairStream(run.outputMessageId ?? '', conversationId)
    },
  )
export const deleteAgentChat = (id: string) =>
  forScreen(
    id,
    async () => {
      await api(`/api/conversations/${id}`, { method: 'DELETE', schema: okResponseSchema })
      return true
    },
    (_, ticket) => engine.leftConversation(id, ticket),
  )

const reading = new Set<string>()
async function repairStream(messageId: string, conversationId: string): Promise<void> {
  if (!messageId || reading.has(messageId)) return
  reading.add(messageId)
  try {
    await forScreen(
      conversationId,
      () => api(`/api/messages/${messageId}`, { schema: messageEnvelopeSchema }),
      (envelope, ticket) => engine.ingestMessage(envelope, ticket),
    )
  } catch {
  } finally {
    reading.delete(messageId)
  }
}
registerStoreReset(() => reading.clear())
export function agentEvent(message: WsServerMessage): void {
  if (message.type === 'agent.delta') {
    const delta: AgentDelta = message.data
    if (engine.ingestAgentDelta(delta) === 'gap')
      void repairStream(delta.messageId, delta.conversationId)
  } else if (message.type === 'agent.run.updated') {
    const detail = useAgent.getState().details[message.data.runId]
    if (detail !== 'denied') void loadRun(message.data.runId, detail?.run.conversationId ?? null)
  }
}
