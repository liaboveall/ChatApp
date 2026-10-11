import type { Me } from '@chatapp/contracts'
import { useEffect } from 'react'
import { keepOffline, persistence } from '@/app/offline.ts'
import { activity } from '@/app/realtime.ts'
import { engine, outbox } from '@/app/sync.ts'
import { useSyncUi } from '@/lib/sync/state.ts'

/**
 * Keeps the sync engine serving the signed-in account while the shell is mounted: it starts for this identity (and starts
 * over when the identity changes underneath, for example after a password change on this device), and it is told when the
 * page returns to the front or the network comes back, which is when whatever was held back is read at once, and
 * whatever was written while there was no network is sent (after the account and the membership are checked, D-205).
 * What the person typed and did not send is put back from the disk once the conversation list is known, and kept there
 * from then on. Stopping is the session's job (`endSession`), not the unmounting of a component.
 */
export function useSyncLifecycle(me: Me): void {
  useEffect(() => {
    void engine.start(me)
  }, [me])

  useEffect(() => keepOffline(), [])

  // The list of the scope is known: now the membership of every conversation is, and what was kept can be put back.
  const loaded = useSyncUi((state) => (state.ready ? state.scope : null))
  useEffect(() => {
    if (loaded !== null) void persistence.restore(loaded)
  }, [loaded])

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        engine.onForeground()
        void outbox.resume()
      }
      activity.touch(false)
    }
    const onOnline = (): void => {
      engine.onForeground()
      void outbox.resume()
    }
    // Any touch of the page counts as "here"; pointer moves are looked at once a second at most.
    let lastMove = 0
    const onInput = (): void => activity.touch()
    const onMove = (): void => {
      const at = Date.now()
      if (at - lastMove < 1000) return
      lastMove = at
      activity.touch()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)
    window.addEventListener('keydown', onInput, { passive: true })
    window.addEventListener('pointerdown', onInput, { passive: true })
    window.addEventListener('wheel', onInput, { passive: true })
    window.addEventListener('pointermove', onMove, { passive: true })
    activity.touch()
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('keydown', onInput)
      window.removeEventListener('pointerdown', onInput)
      window.removeEventListener('wheel', onInput)
      window.removeEventListener('pointermove', onMove)
    }
  }, [])
}
