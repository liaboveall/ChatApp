/** WS frames are hints only: wake a status read; never install state from a frame. */
const listeners = new Map<string, Set<() => void>>()
export function attachmentHint(id: string): void {
  for (const wake of listeners.get(id) ?? []) wake()
}
export function waitForUpload(
  signal: AbortSignal,
  ms: number,
  attachmentId?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (attachmentId) {
        const entries = listeners.get(attachmentId)
        entries?.delete(wake)
        if (!entries?.size) listeners.delete(attachmentId)
      }
      if (error) reject(error)
      else resolve()
    }
    const wake = () => finish()
    const abort = () => finish(new DOMException('Cancelled', 'AbortError'))
    const timer = setTimeout(wake, ms)
    if (attachmentId) {
      const entries = listeners.get(attachmentId) ?? new Set()
      entries.add(wake)
      listeners.set(attachmentId, entries)
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
export const uploadPollDelay = (attempt: number): number =>
  Math.min(10_000, 1000 * 2 ** Math.min(attempt, 4))
