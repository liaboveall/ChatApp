/**
 * The page's side of the conversation with the service worker (D-070, SEC-34, M6): it tells the worker who is signed in
 * (so a push for anybody else is not shown), forgets the account at sign-out, and opens the place of the app a click on a
 * notification asks for. Everything the worker sends carries the account it was made for; the page ignores the rest.
 */
import { type FromWorker, isFromWorker, type ToWorker } from './protocol.ts'
import { currentRegistration } from './register.ts'

/** Sends a message to the active worker, when there is one. Never waits and never throws. */
export async function tellWorker(
  message: ToWorker,
  current: () => boolean = () => true,
): Promise<void> {
  const registration = await currentRegistration()
  // A worker that is still installing has no `active` yet; it asks nothing until the page tells it again at the next sign-in.
  if (current()) registration?.active?.postMessage(message)
}

/** Listens for what the worker says. Returns the function that stops listening. */
export function listenToWorker(onMessage: (message: FromWorker) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined
  const handler = (event: MessageEvent<unknown>): void => {
    if (isFromWorker(event.data)) onMessage(event.data)
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}
