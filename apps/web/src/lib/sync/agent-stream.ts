import type { AgentDelta, Message } from '@chatapp/contracts'

/** Ephemeral batches never advance changeSeq. A gap requires a fresh authorized snapshot. */
export function mergeAgentDelta(
  current: Message | undefined,
  delta: AgentDelta,
): Message | 'gap' | 'ignore' {
  if (!current) return 'gap'
  const meta = current.meta.agent
  if (
    current.status !== 'streaming' ||
    !meta ||
    meta.runId !== delta.runId ||
    (meta.resumeSeq ?? 0) !== delta.resumeSeq ||
    current.recalledAt ||
    current.deletedAt
  )
    return 'ignore'
  const index = meta.streamIndex ?? 0
  if (delta.index <= index || delta.streamRevision < current.streamRevision) return 'ignore'
  if (delta.index !== index + 1) return 'gap'
  return {
    ...current,
    body: (current.body ?? '') + delta.text,
    meta: { ...current.meta, agent: { ...meta, streamIndex: delta.index } },
  }
}
