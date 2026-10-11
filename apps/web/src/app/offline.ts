import { engine, outbox } from '@/app/sync.ts'
import { Persistence } from '@/lib/offline/persistence.ts'
import { OfflineStore } from '@/lib/offline/store.ts'
import { onForgetOffline } from '@/lib/offline/wipe.ts'
import { serverNow } from '@/lib/realtime.ts'

/**
 * The words the person has typed and not sent, and the plain-text messages waiting for the network, kept on disk for this
 * account (D-205). Put back when the conversation list of the scope is loaded (`use-sync-lifecycle`), emptied with the
 * account (`lib/session.ts`).
 */
export const persistence = new Persistence({
  store: new OfflineStore(undefined, serverNow),
  outbox,
  scope: () => engine.scope,
  membershipOf: (conversationId) => engine.membershipOf(conversationId),
  now: serverNow,
})

// The account is forgotten (sign-out here or in another tab, a lost session): writing stops in the same turn.
onForgetOffline(() => persistence.disarm())

/** Follows the stores, and writes at once when the page is hidden or closed. Returns the function that stops. */
export function keepOffline(): () => void {
  const stopWatching = persistence.watch()
  const onHide = (): void => {
    if (document.visibilityState === 'hidden') void persistence.flush()
  }
  const onPageHide = (): void => void persistence.flush()
  document.addEventListener('visibilitychange', onHide)
  window.addEventListener('pagehide', onPageHide)
  return () => {
    stopWatching()
    document.removeEventListener('visibilitychange', onHide)
    window.removeEventListener('pagehide', onPageHide)
  }
}
