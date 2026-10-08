import type { AgentRunDetail } from '@chatapp/contracts'
import { create } from 'zustand'
import { registerConversationReset, registerStoreReset } from '@/lib/sync/stores.ts'

export const useAgent = create<{
  details: Record<string, AgentRunDetail | 'denied'>
  modes: Record<string, 'fast' | 'deep'>
  scopes: Record<string, 'current' | 'all'>
  jumps: Record<string, number>
  /** Empty string selects an unsent new session; absent selects the newest saved session. */
  panels: Record<string, string>
}>(() => ({ details: {}, modes: {}, scopes: {}, jumps: {}, panels: {} }))
export function rememberRun(detail: AgentRunDetail): void {
  useAgent.setState((s) => {
    const previous = s.details[detail.run.id]
    if (previous && previous !== 'denied' && previous.run.stateVersion > detail.run.stateVersion)
      return s
    return { details: { ...s.details, [detail.run.id]: detail } }
  })
}
registerStoreReset(() =>
  useAgent.setState({ details: {}, modes: {}, scopes: {}, jumps: {}, panels: {} }),
)
registerConversationReset((id) =>
  useAgent.setState((s) => ({
    details: Object.fromEntries(
      Object.entries(s.details).filter(
        ([, d]) =>
          d !== 'denied' && d.run.conversationId !== id && d.run.contextConversationId !== id,
      ),
    ),
    modes: Object.fromEntries(Object.entries(s.modes).filter(([key]) => key !== id)),
    scopes: Object.fromEntries(Object.entries(s.scopes).filter(([key]) => key !== id)),
    jumps: Object.fromEntries(Object.entries(s.jumps).filter(([key]) => key !== id)),
    panels: Object.fromEntries(
      Object.entries(s.panels).filter(([key, value]) => key !== id && value !== id),
    ),
  })),
)
