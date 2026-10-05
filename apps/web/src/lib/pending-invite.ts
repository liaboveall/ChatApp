/**
 * A group invitation link opened by someone who is not signed in (D-156). The code travels through the sign-in in this
 * tab's session storage and nowhere else: not in the address, not in local storage, not in another tab. It is good for
 * fifteen minutes, it is deleted the moment it is read, and ending a session deletes it too.
 */
import { session } from './storage.ts'

const KEY = 'chatapp.pending-invite'
/** How long a code waits for the person to finish signing in. */
export const PENDING_INVITE_TTL_MS = 15 * 60_000

export function savePendingInvite(code: string, now = Date.now()): void {
  session.set(KEY, JSON.stringify({ code, savedAt: now }))
}

/** The waiting code, once: reading it removes it. Anything stale or malformed is as good as none. */
export function takePendingInvite(now = Date.now()): string | null {
  const raw = session.get(KEY)
  session.remove(KEY)
  if (raw === null) return null
  try {
    const stored = JSON.parse(raw) as { code?: unknown; savedAt?: unknown }
    if (typeof stored.code !== 'string' || typeof stored.savedAt !== 'number') return null
    if (now - stored.savedAt > PENDING_INVITE_TTL_MS || stored.savedAt > now + 60_000) return null
    return stored.code
  } catch {
    return null
  }
}

export function clearPendingInvite(): void {
  session.remove(KEY)
}
