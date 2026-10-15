import { type DeletionOperation, deletionOperationSchema } from '@chatapp/contracts'
import { engine } from '@/app/sync.ts'
import { api } from '@/lib/api.ts'
import type { RequestTicket } from '@/lib/sync/types.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'

/** A prepared deletion remains visible. Neither a 202 nor an old account's completion may show success. */
export async function waitForDeletion(
  operation: DeletionOperation,
  ticket: RequestTicket,
  options: { signal?: AbortSignal; pendingToast?: boolean } = {},
): Promise<boolean> {
  const { signal } = options
  const current = () => !signal?.aborted && engine.isCurrent(ticket)
  if (!current()) return false
  if (operation.status === 'completed') return true
  if (options.pendingToast !== false) showToast(m.deletion_pending())
  let status = operation
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, 2000)
      signal?.addEventListener('abort', done, { once: true })
      if (signal?.aborted) done()
    })
    if (!current()) return false
    try {
      const answer = await api(operation.statusUrl, { schema: deletionOperationSchema, signal })
      if (
        answer.operationId !== operation.operationId ||
        answer.statusUrl !== operation.statusUrl ||
        answer.version < status.version
      )
        continue
      status = answer
    } catch {
      if (!current()) return false
      // A transient outage preserves the original operation; never re-submit a different logical deletion.
      continue
    }
    if (!current()) return false
    if (status.status === 'completed') {
      showToast(m.deletion_completed())
      return true
    }
    if (status.status === 'failed') return false
  }
  return false // The durable worker continues, and the normal sync log carries completion to every device.
}
