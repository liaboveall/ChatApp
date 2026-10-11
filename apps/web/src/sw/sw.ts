/// <reference lib="webworker" />
/**
 * The service worker (docs/03 section 11, D-070, M6). It does three things and nothing else:
 *
 *  - keeps the public shell of the app (the page, its scripts, styles, fonts and icons) so the app opens without a network;
 *    it caches nothing else, so no answer of the API, no message and no attachment is ever kept here (SEC-08, SEC-34);
 *  - shows a push, after checking that it is for the account signed in on this browser, and opens the app where a click asks;
 *  - forgets the account when it signs out.
 */
import { clientsClaim } from 'workbox-core'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { AUTH_CHANNEL, type FromWorker, isToWorker, SAFE_PATH } from '../lib/pwa/protocol.ts'
import { clearIdentity, type Identity, readIdentity, writeIdentity } from './identity.ts'
import { forgetApplies, isForAccount, parsePayload } from './payload.ts'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>
}

// A new version takes over at once; pages that are open keep what they loaded and use the new worker for what comes next.
self.skipWaiting()
clientsClaim()
cleanupOutdatedCaches()

// The public shell. The list is made by the build from what it wrote (hashed assets, the page, icons, the manifest).
precacheAndRoute(self.__WB_MANIFEST)

// Every navigation of the app answers with the shell; the API and the live connection are not pages and are left alone, so
// they are never answered from here.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api(?:\/|$)/, /^\/ws(?:\/|$)/],
  }),
)

// ───────── badge ─────────

async function setBadge(count: number): Promise<void> {
  const nav = self.navigator as WorkerNavigator & {
    setAppBadge?: (count?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  try {
    if (count > 0) await nav.setAppBadge?.(count)
    else await nav.clearAppBadge?.()
  } catch {
    // No Badging API here.
  }
}

// ───────── forgetting ─────────

// Identity reads/writes and push display share an order. An asynchronous forget must not clear a newer identity, and a
// push that started under the previous identity must finish before the handover clears that person's shown notifications.
let identityTasks: Promise<void> = Promise.resolve()
function withIdentity(action: () => Promise<void>): Promise<void> {
  const task = identityTasks.then(action)
  identityTasks = task.catch(() => undefined)
  return task
}

async function identify(identity: Identity): Promise<void> {
  await writeIdentity(identity)
  // The old logout may have been abandoned when a new session started. Handover itself therefore closes what was already
  // displayed for the previous account; the new account's notifications survive.
  for (const notification of await self.registration.getNotifications()) {
    const data = notification.data as { userId?: unknown } | null
    if (data?.userId !== identity.userId) notification.close()
  }
}

async function forget(about?: string): Promise<void> {
  if (!forgetApplies((await readIdentity())?.userId, about)) return
  await clearIdentity()
  const shown = await self.registration.getNotifications()
  for (const notification of shown) notification.close()
  // The badge is not touched here: a sign-out always comes from a page, and the page clears it as the shell goes
  // (`useUnreadIndicators`). A browser build without the badge service for workers (Chromium's headless test build)
  // ends the whole renderer, the page with it, when a worker asks for one.
}

try {
  const channel = new BroadcastChannel(AUTH_CHANNEL)
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const data = event.data as { type?: unknown; userId?: unknown } | null
    if (data?.type === 'signed-out')
      void withIdentity(() => forget(typeof data.userId === 'string' ? data.userId : undefined))
  }
} catch {
  // No BroadcastChannel in this worker: the page tells it directly.
}

self.addEventListener('message', (event) => {
  const message: unknown = event.data
  if (!isToWorker(message)) return
  event.waitUntil(
    withIdentity(() =>
      message.type === 'identity'
        ? identify({ userId: message.userId, installationId: message.installationId })
        : forget(message.userId),
    ),
  )
})

// ───────── push ─────────

async function showPush(event: PushEvent): Promise<void> {
  const payload = event.data ? parsePayload(event.data.text()) : null
  const identity = await readIdentity()
  if (!payload) return
  if (!isForAccount(payload, identity?.userId)) {
    // A foreign payload cannot establish who owns the current browser subscription, even if the identity has not arrived
    // yet. Cleanup belongs to the page's guarded logout/disable operation and the server's session-bound subscription.
    // An old push in flight must never unsubscribe an installation being handed to a new account.
    return
  }
  await setBadge(payload.unread)
  // A window of the app that is in front, and already on that conversation, makes a notification pointless.
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const looking = windows.some(
    (client) =>
      client.visibilityState === 'visible' &&
      client.focused &&
      new URL(client.url).pathname === payload.url,
  )
  if (looking) return
  const options: NotificationOptions & { renotify?: boolean } = {
    body: payload.body,
    tag: payload.tag,
    icon: '/icons/icon-192.png',
    data: { url: payload.url, userId: payload.userId },
    // Each new message makes a sound again even though it replaces the one before it.
    renotify: true,
  }
  await self.registration.showNotification(payload.title, options)
}

self.addEventListener('push', (event) => event.waitUntil(withIdentity(() => showPush(event))))

// ───────── a click on a notification ─────────

async function openApp(url: string, userId: string): Promise<void> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const target = windows.find((client) => client.focused) ?? windows[0]
  if (target) {
    try {
      await target.focus()
    } catch {
      // A browser only lets a click bring a window forward; without one (a test, an old browser) the page is still told.
    }
    const message: FromWorker = { type: 'open', userId, url }
    target.postMessage(message)
    return
  }
  await self.clients.openWindow(url)
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data as { url?: unknown; userId?: unknown } | null
  const url = typeof data?.url === 'string' && SAFE_PATH.test(data.url) ? data.url : '/'
  const userId = typeof data?.userId === 'string' ? data.userId : ''
  event.waitUntil(openApp(url, userId))
})

// ───────── the browser changed the subscription ─────────

self.addEventListener('pushsubscriptionchange', (event) => {
  const change = event as ExtendableEvent & { oldSubscription?: PushSubscription | null }
  change.waitUntil(
    (async () => {
      const identity = await readIdentity()
      if (!identity) return
      const subscription = await self.registration.pushManager.subscribe(
        change.oldSubscription?.options ?? { userVisibleOnly: true },
      )
      const current = await readIdentity()
      if (current?.userId !== identity.userId || current.installationId !== identity.installationId)
        return
      const json = subscription.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return
      await fetch('/api/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          installationId: identity.installationId,
          expectedUserId: identity.userId,
        }),
      })
    })().catch(() => undefined),
  )
})
