/**
 * Turning browser push on and off for this device (docs/01 section 4.8, docs/05 section 3.7, D-203, M6). The browser's own
 * subscription is made first, then the server is told; if the server refuses, the browser's subscription is dropped again,
 * so nothing is left half-made. Every request is made for the person in front of the screen (`forScreen`, D-174).
 */
import {
  pushSubscriptionListSchema,
  pushSubscriptionResponseSchema,
  pushTestResponseSchema,
  vapidKeyResponseSchema,
} from '@chatapp/contracts'
import { z } from 'zod'
import { engine, forScreen } from '@/app/sync.ts'
import { ApiError, api } from '@/lib/api.ts'
import { installationId } from '@/lib/push/installation.ts'
import { keyBytes, notificationPermission, pushSupport, sameKey } from '@/lib/push/support.ts'
import { tellWorker } from '@/lib/pwa/bridge.ts'
import { currentRegistration } from '@/lib/pwa/register.ts'

const pushIdSchema = z.object({ id: z.uuid() })

export type EnableResult =
  | 'enabled'
  | 'unsupported'
  | 'denied'
  | 'dismissed'
  | 'no-worker'
  | 'refused'
  | 'failed'
  | 'session-changed'

/** Makes this installation's subscription and registers it with the server; returns what happened. */
export async function enablePushHere(userId: string): Promise<EnableResult> {
  // Capture before the browser's permission dialog: each subsequent await still belongs to this login, even before an
  // HTTP request exists. Taking a new ticket for each request alone could bind the old operation to the next account.
  const ticket = engine.ticket(null)
  const current = () => engine.isCurrent(ticket)
  if (ticket.scope?.userId !== userId || !current()) return 'session-changed'
  if (!pushSupport().supported) return 'unsupported'
  if (notificationPermission() === 'denied') return 'denied'
  const permission = await Notification.requestPermission()
  if (!current()) return 'session-changed'
  if (permission === 'denied') return 'denied'
  if (permission !== 'granted') return 'dismissed'

  const registration = await currentRegistration()
  if (!current()) return 'session-changed'
  if (!registration) return 'no-worker'
  let made = false
  try {
    const key = await forScreen(null, () =>
      api('/api/push/vapid-key', { schema: vapidKeyResponseSchema }),
    )
    if (key === null || !current()) return 'session-changed'
    const wanted = keyBytes(key.publicKey)
    let subscription = await registration.pushManager.getSubscription()
    if (!current()) return 'session-changed'
    // A subscription made under another application server key (the keys were replaced) is of no use any more.
    if (subscription && !sameKey(subscription.options.applicationServerKey, wanted)) {
      await subscription.unsubscribe()
      if (!current()) return 'session-changed'
      subscription = null
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: wanted,
      })
      made = true
      if (!current()) return 'session-changed'
    }
    // The worker has to know whose pushes to show before the first one arrives.
    await tellWorker({ type: 'identity', userId, installationId: installationId() }, current)
    if (!current()) return 'session-changed'
    const json = subscription.toJSON()
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
      throw new Error('incomplete subscription')
    const saved = await forScreen(null, () =>
      api('/api/push/subscriptions', {
        method: 'POST',
        json: {
          endpoint: json.endpoint,
          keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
          installationId: installationId(),
          expectedUserId: userId,
        },
        schema: pushSubscriptionResponseSchema,
      }),
    )
    if (saved === null) {
      return 'session-changed'
    }
    return 'enabled'
  } catch (error) {
    if (!current()) return 'session-changed'
    if (made) {
      try {
        const subscription = await registration.pushManager.getSubscription()
        if (current()) await subscription?.unsubscribe()
      } catch {
        // Already gone.
      }
    }
    // The server said no (a limit, an endpoint it does not accept): that is not the browser's fault, and is worded as such.
    return error instanceof ApiError && error.status >= 400 && error.status < 500
      ? 'refused'
      : 'failed'
  }
}

/** Removes this installation's subscription from the server and from the browser. Returns false if the server could not be told. */
export async function disablePushHere(): Promise<boolean> {
  const ticket = engine.ticket(null)
  const current = () => engine.isCurrent(ticket)
  if (!current()) return false
  const registration = await currentRegistration()
  if (!current()) return false
  let told = true
  try {
    const list = await forScreen(null, () =>
      api(`/api/push/subscriptions?installationId=${installationId()}`, {
        schema: pushSubscriptionListSchema,
      }),
    )
    if (list === null || !current()) return false
    for (const entry of list.subscriptions.filter((item) => item.current)) {
      const removed = await forScreen(null, () =>
        api(`/api/push/subscriptions/${entry.id}`, { method: 'DELETE', schema: pushIdSchema }),
      )
      if (removed === null || !current()) return false
    }
  } catch {
    told = false
  }
  try {
    if (!current()) return false
    const subscription = await registration?.pushManager.getSubscription()
    if (!current()) return false
    await subscription?.unsubscribe()
  } catch {
    // Already gone.
  }
  return current() && told
}

/** Removes a subscription of another device of mine. */
export async function removePushDevice(id: string): Promise<boolean> {
  try {
    const done = await forScreen(null, () =>
      api(`/api/push/subscriptions/${id}`, { method: 'DELETE', schema: pushIdSchema }),
    )
    return done !== null
  } catch {
    return false
  }
}

/** Asks the server to send a test push to this device. Returns whether one was queued. */
export async function sendTestPush(): Promise<boolean> {
  try {
    const answer = await forScreen(null, () =>
      api('/api/push/test', {
        method: 'POST',
        json: { installationId: installationId() },
        schema: pushTestResponseSchema,
      }),
    )
    return answer?.queued === true
  } catch {
    return false
  }
}
