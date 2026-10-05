/**
 * The signed-in session on the client side. When the account's session ends (sign-out, a 401 from the API, a 4401 from
 * the WebSocket, a sign-out in another tab) everything account-related is dropped at once: queries are cancelled and
 * cleared, the connection is closed, account-scoped storage is wiped, and the other tabs are told (D-070).
 */
import type { QueryClient } from '@tanstack/react-query'
import { setUnauthenticatedHandler } from './api.ts'
import { clearPendingInvite } from './pending-invite.ts'
import { queryKeys } from './queries.ts'
import { clearScopedStorage } from './storage.ts'
import { announce, listen } from './tab-sync.ts'

/** Why the user is back at the sign-in page; the page explains it. */
export type SessionEnd = 'signed-out' | 'expired' | 'ended-elsewhere' | 'password-changed'

export type SessionDeps = {
  queryClient: QueryClient
  /** Closes the realtime connection and forgets its state. */
  stopRealtime: () => void
  /**
   * Stops the sync engine and empties every client store that holds conversation data (drafts, unsent messages, typing,
   * presence). Passed in, not imported, so this module does not depend on the sync layer (and the sync layer may use it).
   */
  resetClientState: () => void
  /** Navigates to the sign-in page. */
  toSignIn: (reason: SessionEnd) => void
  /** Another tab signed in: re-run the route guards. */
  onSignedInElsewhere: () => void
}

let deps: SessionDeps | undefined
/** Bumped on every reset: an answer to a request from an earlier generation must be dropped (docs/05 section 2). */
let generation = 0
/**
 * Whether this tab currently has a signed-in session to lose. Several signals can announce the same loss (a 401, the
 * WebSocket, another tab, a refetch); only the first one acts. The query cache cannot tell, because a probe that finds
 * nobody signed in writes that into the cache before this module hears of it.
 */
let active = false

/** The identity check found a signed-in user (page load, sign-in): from now on a loss is worth acting on. */
export function markSignedIn(): void {
  active = true
}

export function currentGeneration(): number {
  return generation
}

/** Local reset without telling anyone else. */
function resetLocal(): void {
  if (!deps) return
  generation += 1
  deps.stopRealtime()
  deps.resetClientState()
  void deps.queryClient.cancelQueries()
  deps.queryClient.clear()
  deps.queryClient.setQueryData(queryKeys.me, null)
  clearScopedStorage()
  clearPendingInvite()
}

/** The session is gone (signed out here, or the server said so). Idempotent while no new session exists. */
export function endSession(reason: SessionEnd, options: { announce?: boolean } = {}): void {
  if (!deps) return
  if (!active && reason !== 'signed-out') return
  active = false
  resetLocal()
  if (options.announce !== false) announce({ type: 'signed-out', reason })
  deps.toSignIn(reason)
}

/** A sign-in succeeded in this tab: refresh the identity and tell the other tabs. */
export function sessionStarted(): void {
  if (!deps) return
  active = true
  generation += 1
  void deps.queryClient.invalidateQueries({ queryKey: queryKeys.me })
  announce({ type: 'signed-in' })
}

/** Wires the client to the API's 401 answers and to the other tabs. Returns the teardown. */
export function startSession(next: SessionDeps): () => void {
  deps = next
  setUnauthenticatedHandler(() => endSession('expired'))
  const stopListening = listen((message) => {
    if (message.type === 'signed-out') {
      endSession(message.reason === 'password-changed' ? 'password-changed' : 'ended-elsewhere', {
        announce: false,
      })
    } else {
      next.onSignedInElsewhere()
    }
  })
  return () => {
    stopListening()
    setUnauthenticatedHandler(undefined)
    deps = undefined
    active = false
  }
}
