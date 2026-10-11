/**
 * What the browser keeps for the signed-in account outside the page itself (D-070, SEC-34, M6): the push subscription and the
 * service worker's idea of who is signed in. When the session ends, by any route, all of it goes.
 */
import { tellWorker } from './bridge.ts'
import { currentRegistration } from './register.ts'

/**
 * The account is gone from this browser: the worker forgets it and stops showing its pushes, and the subscription is dropped.
 * `userId` is the account that signed out, so that a late message cannot undo the sign-in of the next one.
 */
export async function forgetDevice(
  userId?: string,
  current: () => boolean = () => true,
): Promise<void> {
  void tellWorker(
    userId === undefined ? { type: 'signed-out' } : { type: 'signed-out', userId },
    current,
  )
  try {
    const registration = await currentRegistration()
    if (!current()) return
    const subscription = await registration?.pushManager.getSubscription()
    if (!current()) return
    await subscription?.unsubscribe()
  } catch {
    // Nothing subscribed, or push is not available here: there is nothing to drop.
  }
}
