/**
 * What the page and the service worker say to each other (M6, D-070). Plain data in both directions; nothing here touches
 * the DOM or the worker scope, so the page and the worker both import it. A message from the worker carries the account it
 * was made for, and the page ignores one that is not for the account that is signed in now (SEC-34).
 */

/** Page → worker. */
export type ToWorker =
  /** Who is signed in on this browser, and which browser installation this is: pushes for anybody else are not shown. */
  | { type: 'identity'; userId: string; installationId: string }
  /**
   * Nobody is signed in any more: forget the account and take down what was shown for it. `userId` names the account that
   * signed out; a message that arrives after somebody else has signed in (a tab of the previous person that woke up late) is
   * then not about them and changes nothing.
   */
  | { type: 'signed-out'; userId?: string }

/** Worker → page. */
export type FromWorker =
  /** A click on a notification asks the page to show this place of the app. */
  { type: 'open'; userId: string; url: string }

export const AUTH_CHANNEL = 'chatapp.auth'

/** A same-origin path of the app, nothing else: what a notification may open. */
export const SAFE_PATH = /^\/[A-Za-z0-9/_-]{0,199}$/

export function isToWorker(value: unknown): value is ToWorker {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; userId?: unknown; installationId?: unknown }
  if (message.type === 'signed-out')
    return message.userId === undefined || typeof message.userId === 'string'
  return (
    message.type === 'identity' &&
    typeof message.userId === 'string' &&
    message.userId.length > 0 &&
    typeof message.installationId === 'string' &&
    message.installationId.length > 0
  )
}

export function isFromWorker(value: unknown): value is FromWorker {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { type?: unknown; userId?: unknown; url?: unknown }
  return (
    message.type === 'open' &&
    typeof message.userId === 'string' &&
    typeof message.url === 'string' &&
    SAFE_PATH.test(message.url)
  )
}
