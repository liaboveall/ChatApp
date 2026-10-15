/** The only information retained through the requesting account's logout is its own short-lived status locator. */
import { type DeletionOperation, deletionOperationSchema } from '@chatapp/contracts'
import { z } from 'zod'
import { session } from './storage.ts'

type PendingAccountDeletion = { userId: string; operation: DeletionOperation; expiresAt: number }
const KEY = 'chatapp.account-deletion-status'
const TTL_MS = 10 * 60_000
const pendingSchema = z
  .object({ userId: z.uuid(), operation: deletionOperationSchema, expiresAt: z.number().int() })
  .strict()
let pending: PendingAccountDeletion | null = null
export function rememberAccountDeletion(userId: string, operation: DeletionOperation) {
  // This tab may reload after its session was revoked. Store only the locator; the HttpOnly receipt stays with the browser.
  pending = { userId, operation: { ...operation }, expiresAt: Date.now() + TTL_MS }
  session.set(KEY, JSON.stringify(pending))
}
export function pendingAccountDeletion(userId?: string): PendingAccountDeletion | null {
  if (!pending) {
    const raw = session.get(KEY)
    if (raw !== null) {
      try {
        const parsed = pendingSchema.safeParse(JSON.parse(raw))
        if (
          parsed.success &&
          parsed.data.operation.status === 'pending' &&
          parsed.data.operation.statusUrl ===
            `/api/deletion-operations/${parsed.data.operation.operationId}` &&
          parsed.data.expiresAt <= Date.now() + TTL_MS
        )
          pending = parsed.data
        else session.remove(KEY)
      } catch {
        session.remove(KEY)
      }
    }
  }
  if (pending && pending.expiresAt <= Date.now()) forgetAccountDeletion()
  return pending && (userId === undefined || userId === pending.userId) ? pending : null
}
export function forgetAccountDeletion() {
  pending = null
  session.remove(KEY)
}

/** Used only by the anonymous sign-in page, with a generation check and a receipt limited to this one GET path. */
export async function observeAccountDeletion(
  record: PendingAccountDeletion,
  options: {
    signal: AbortSignal
    current: () => boolean
    read: (url: string) => Promise<DeletionOperation>
    completed: () => void
  },
): Promise<void> {
  const current = () =>
    !options.signal.aborted &&
    options.current() &&
    pending === record &&
    record.expiresAt > Date.now()
  let version = record.operation.version
  while (current()) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        options.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, 2000)
      options.signal.addEventListener('abort', done, { once: true })
      if (options.signal.aborted) done()
    })
    if (!current()) return
    let answer: DeletionOperation
    try {
      answer = await options.read(record.operation.statusUrl)
    } catch {
      continue
    }
    if (!current()) return
    if (
      answer.operationId !== record.operation.operationId ||
      answer.statusUrl !== record.operation.statusUrl ||
      answer.version < version
    )
      continue
    version = answer.version
    record.operation = { ...answer }
    session.set(KEY, JSON.stringify(record))
    if (answer.status === 'completed') {
      forgetAccountDeletion()
      options.completed()
      return
    }
    if (answer.status === 'failed') return
  }
}
