import type { Me } from '@chatapp/contracts'
import { useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { installationId } from '@/lib/push/installation.ts'
import { listenToWorker, tellWorker } from '@/lib/pwa/bridge.ts'
import { engine } from './sync.ts'

/**
 * The signed-in shell's side of the service worker (D-070, SEC-34, M6): tells it whose pushes to show, and goes where a click
 * on a notification asks. A click made for another account (the notification outlived a sign-out) goes nowhere.
 */
export function usePwaBridge(me: Me): void {
  const router = useRouter()
  useEffect(() => {
    const ticket = engine.ticket(null)
    void tellWorker(
      { type: 'identity', userId: me.id, installationId: installationId() },
      () => ticket.scope?.userId === me.id && engine.isCurrent(ticket),
    )
  }, [me.id])
  useEffect(
    () =>
      listenToWorker((message) => {
        if (message.userId !== me.id) return
        router.history.push(message.url)
      }),
    [me.id, router],
  )
}
