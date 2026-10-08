import {
  type AgentApproval,
  type AgentApprovalDecision,
  type AgentDelta,
  type AgentRunRequest,
  agentApprovalResponseSchema,
  agentContextResponseSchema,
  agentRunDetailSchema,
  agentRunResponseSchema,
  conversationSchema,
  memoryResponseSchema,
  messageEnvelopeSchema,
  okResponseSchema,
  reminderResponseSchema,
  type WsServerMessage,
} from '@chatapp/contracts'
import { engine, forScreen } from '@/app/sync.ts'
import { ApiError, api } from '@/lib/api.ts'
import { queryClient } from '@/lib/query-client.ts'
import { useDrafts } from '@/lib/sync/drafts.ts'
import { registerStoreReset } from '@/lib/sync/stores.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { rememberContext, rememberRun, useAgent } from './store.ts'

export const undoMemory = (id: string, conversationId: string) =>
  forScreen(
    conversationId,
    () => api(`/api/me/memories/${id}`, { method: 'DELETE', schema: memoryResponseSchema }),
    () => {
      void queryClient.invalidateQueries({ queryKey: ['memories'] })
    },
  )

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
      const context =
        run.conversationId && run.trigger !== 'mention'
          ? await api(`/api/agent/conversations/${run.conversationId}/context`, {
              schema: agentContextResponseSchema,
            })
          : null
      return { run, conversation, context }
    },
    ({ run, conversation, context }, ticket) => {
      if (conversation) engine.ingestConversation(conversation, ticket)
      if (context) rememberContext(context)
      rememberRun({ run, steps: [], approvals: [], effects: [] })
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
    ({ run }) => rememberRun({ run, steps: [], approvals: [], effects: [] }),
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
      rememberRun({ run, steps: [], approvals: [], effects: [] })
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

/**
 * The caller decides one request (docs/05 section 3.6). The answer's run is remembered at once; the details (approvals,
 * effects) are read again, since a decision can resume the run.
 */
export const decideApproval = (
  approval: AgentApproval,
  conversationId: string,
  body: AgentApprovalDecision,
) =>
  forScreen(
    conversationId,
    () =>
      api(`/api/agent/approvals/${approval.id}`, {
        method: 'POST',
        json: body,
        schema: agentApprovalResponseSchema,
      }),
    ({ run }) => void loadRun(run.id, run.conversationId),
  )

/** A blank segment with the other key source (docs/06 section 3.1): nothing earlier is carried over. */
export const switchKeySource = (conversationId: string, keySource: 'site' | 'user') =>
  forScreen(
    conversationId,
    () =>
      api(`/api/agent/conversations/${conversationId}/key-source`, {
        method: 'POST',
        json: { keySource },
        schema: agentContextResponseSchema,
      }),
    (context) => {
      rememberContext(context)
      useDrafts.setState((s) => ({
        byConversation: Object.fromEntries(
          Object.entries(s.byConversation).filter(
            ([id]) => id !== conversationId && !id.endsWith(`:${conversationId}`),
          ),
        ),
        previews: Object.fromEntries(
          Object.entries(s.previews).filter(
            ([id]) => id !== conversationId && !id.endsWith(`:${conversationId}`),
          ),
        ),
      }))
      void queryClient.invalidateQueries({ queryKey: ['agent-usage'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-context'] })
    },
  )

/** The undo of an automatic reminder: cancelling it, which a repeated request answers with its end state. */
export const undoReminder = (reminderId: string, conversationId: string) =>
  forScreen(
    conversationId,
    () => api(`/api/reminders/${reminderId}`, { method: 'DELETE', schema: reminderResponseSchema }),
    () => void queryClient.invalidateQueries({ queryKey: ['tasks'] }),
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
  } else if (message.type === 'task.changed') {
    // Task lists are read over HTTP; the hint only says that one of them is out of date.
    void queryClient.invalidateQueries({ queryKey: ['tasks'] })
  }
}
