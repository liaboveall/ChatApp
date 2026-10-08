import { type AgentContext, agentContextResponseSchema } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { forScreen } from '@/app/sync.ts'
import { api } from '@/lib/api.ts'
import { useSyncScope } from '@/lib/sync/hooks.ts'
import type { TimelineWindow } from '@/lib/sync/types.ts'
import { rememberContext, useAgent } from './store.ts'

/** Persisted segment identity, rather than the source of a historical run, controls the current screen. */
export function useAgentContext(conversationId: string | undefined) {
  const scope = useSyncScope()
  useQuery({
    queryKey: ['agent-context', scope?.userId, scope?.generation, conversationId],
    enabled: scope !== null && !!conversationId,
    refetchInterval: 5000,
    queryFn: () =>
      forScreen(
        conversationId ?? null,
        () =>
          api(`/api/agent/conversations/${conversationId}/context`, {
            schema: agentContextResponseSchema,
          }),
        rememberContext,
      ),
  })
  return useAgent((s) => (conversationId ? s.contexts[conversationId] : undefined))
}
export function segmentWindow(window: TimelineWindow, context: AgentContext): TimelineWindow {
  const messages = window.messages.filter((m) => m.seq > context.historyFromSeq)
  return {
    ...window,
    messages,
    hasMoreBefore:
      window.hasMoreBefore &&
      (!window.messages.length || (window.messages[0]?.seq ?? 0) > context.historyFromSeq),
  }
}
