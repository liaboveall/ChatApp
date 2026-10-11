/**
 * The simulated push service of the end-to-end tests (docs/08 scenario 9, D-203). A headless browser cannot subscribe to a real
 * push service, so the browser's subscription is faked in the page (its endpoint is a name the server accepts, its keys are
 * ones the test holds); the server's worker records what it would have sent instead of sending it (APP_ENV=test); the test
 * reads that back, decrypts it as a browser would, checks the VAPID signature, and hands the plaintext to the real service
 * worker through the browser's own push entry point (Chrome DevTools `ServiceWorker.deliverPushMessage`), so the worker's code
 * runs exactly as it does for a real push.
 *
 * The decryption is written here on purpose, separately from the server's: two implementations of RFC 8291 agreeing with each
 * other is the check that matters.
 */
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from 'node:crypto'
import type { APIRequestContext, Browser, BrowserContext, Page, Worker } from '@playwright/test'
import { expect, newContext } from './fixtures.ts'
import { openSettings } from './ui.ts'

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')

export type PushKeys = {
  endpoint: string
  p256dh: string
  auth: string
  publicKey: Buffer
  privateKey: Buffer
  authSecret: Buffer
}

/** A browser's subscription keys and an endpoint on a host the server's list accepts. */
export function newBrowserKeys(label = 'e2e'): PushKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const authSecret = randomBytes(16)
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${label}-${randomBytes(12).toString('hex')}`,
    p256dh: b64u(ecdh.getPublicKey()),
    auth: b64u(authSecret),
    publicKey: ecdh.getPublicKey(),
    privateKey: ecdh.getPrivateKey(),
    authSecret,
  }
}

/** The switch of Settings → Notifications that turns push on for the browser in front of the person. */
export const SWITCH_HERE = '在这台设备上接收推送'

/** A browser of its own that may show notifications and whose push subscription is the one the test holds the keys of. */
export async function newPushBrowser(
  browser: Browser,
  origin: string,
  keys: PushKeys,
): Promise<BrowserContext> {
  const context = await newContext(browser)
  await context.grantPermissions(['notifications'], { origin })
  await installFakePush(context, keys)
  return context
}

/** Settings → Notifications → "receive pushes on this device", through the screen. */
export async function turnOnPush(page: Page): Promise<void> {
  await openSettings(page, 'notifications')
  const toggle = page.getByRole('switch', { name: SWITCH_HERE })
  await expect(toggle).toBeEnabled()
  await toggle.click()
  await expect(toggle).toBeChecked()
}

/** Replaces `PushManager` in every page of the context with one that hands out the test's subscription. */
export async function installFakePush(context: BrowserContext, keys: PushKeys): Promise<void> {
  await context.addInitScript(
    ({ endpoint, p256dh, auth }) => {
      const STORE = 'e2e.fake-push'
      const bytes = (text: string): ArrayBuffer => {
        const padded = text.replaceAll('-', '+').replaceAll('_', '/')
        const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
        return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer
      }
      const text = (buffer: ArrayBuffer | Uint8Array): string =>
        btoa(String.fromCharCode(...new Uint8Array(buffer instanceof Uint8Array ? buffer : buffer)))
          .replaceAll('+', '-')
          .replaceAll('/', '_')
          .replace(/=+$/, '')
      const make = (serverKey: string) => ({
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: bytes(serverKey) },
        getKey: (name: string) => bytes(name === 'p256dh' ? p256dh : auth),
        toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth } }),
        unsubscribe: async () => {
          sessionStorage.removeItem(STORE)
          return true
        },
      })
      PushManager.prototype.getSubscription = async () => {
        const key = sessionStorage.getItem(STORE)
        return key === null ? null : (make(key) as unknown as PushSubscription)
      }
      PushManager.prototype.subscribe = async (options?: PushSubscriptionOptionsInit) => {
        const key = options?.applicationServerKey
        if (key === undefined || key === null) throw new Error('no application server key')
        const asText = typeof key === 'string' ? key : text(key as ArrayBuffer | Uint8Array)
        sessionStorage.setItem(STORE, asText)
        return make(asText) as unknown as PushSubscription
      }
    },
    { endpoint: keys.endpoint, p256dh: keys.p256dh, auth: keys.auth },
  )
}

export type Captured = {
  endpoint: string
  headers: Record<string, string>
  bodyBase64Url: string
  at: string
}

/** Everything the simulated push service has taken for one endpoint. */
export async function capturedFor(api: APIRequestContext, endpoint: string): Promise<Captured[]> {
  const response = await api.get('/api/test/push/captured')
  const { items } = (await response.json()) as { items: Captured[] }
  return items.filter((item) => item.endpoint === endpoint)
}

export async function waitForCaptured(
  api: APIRequestContext,
  endpoint: string,
  count = 1,
  timeoutMs = 15_000,
): Promise<Captured[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await capturedFor(api, endpoint)
    if (found.length >= count) return found
    if (Date.now() > deadline)
      throw new Error(
        `no push for ${endpoint} within ${timeoutMs} ms (${found.length} of ${count})`,
      )
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

const info = (text: string): Buffer => Buffer.from(text, 'utf8')

/** RFC 8291 section 3.4 and RFC 8188, the receiving side, from the RFC text and nothing of the server's code. */
export function decrypt(captured: Captured, keys: PushKeys): string {
  const body = Buffer.from(captured.bodyBase64Url, 'base64url')
  const salt = body.subarray(0, 16)
  const idLength = body.readUInt8(20)
  const senderPublic = body.subarray(21, 21 + idLength)
  const encrypted = body.subarray(21 + idLength)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(keys.privateKey)
  const shared = ecdh.computeSecret(senderPublic)
  const ikm = Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      keys.authSecret,
      Buffer.concat([info('WebPush: info\0'), keys.publicKey, senderPublic]),
      32,
    ),
  )
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, info('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, info('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16))
  const record = Buffer.concat([
    decipher.update(encrypted.subarray(0, encrypted.length - 16)),
    decipher.final(),
  ])
  let end = record.length
  while (end > 0 && record[end - 1] === 0) end -= 1
  if (record[end - 1] !== 0x02) throw new Error('the record does not end with the final delimiter')
  return record.subarray(0, end - 1).toString('utf8')
}

/** The `Authorization` header of a push as a push service checks it (RFC 8292): returns the claims, or null if it does not verify. */
export function verifyVapid(
  authorization: string,
  publicKey: string,
): { aud: string; exp: number; sub: string } | null {
  const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(authorization)
  if (!match || match[4] !== publicKey) return null
  const [, header, claims, signature] = match
  const point = Buffer.from(publicKey, 'base64url')
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
    },
    format: 'jwk',
  })
  const ok = verify(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature ?? '', 'base64url'),
  )
  return ok
    ? (JSON.parse(Buffer.from(claims ?? '', 'base64url').toString('utf8')) as {
        aud: string
        exp: number
        sub: string
      })
    : null
}

type Registration = { registrationId: string; scopeURL: string; isDeleted: boolean }

/** Hands a push to the service worker of the origin through the browser's own entry point, as the push service would. */
export async function deliverToWorker(
  context: BrowserContext,
  anyPage: Page,
  origin: string,
  plaintext: string,
): Promise<void> {
  const session = await context.newCDPSession(anyPage)
  const registrations = new Map<string, Registration>()
  session.on(
    'ServiceWorker.workerRegistrationUpdated',
    (event: { registrations: Registration[] }) => {
      for (const registration of event.registrations)
        registrations.set(registration.registrationId, registration)
    },
  )
  await session.send('ServiceWorker.enable')
  const deadline = Date.now() + 10_000
  while (![...registrations.values()].some((r) => !r.isDeleted && r.scopeURL.startsWith(origin))) {
    if (Date.now() > deadline) throw new Error('the service worker registration was not reported')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const registration = [...registrations.values()].find(
    (r) => !r.isDeleted && r.scopeURL.startsWith(origin),
  )
  if (!registration) throw new Error('no registration')
  await session.send('ServiceWorker.deliverPushMessage', {
    origin,
    registrationId: registration.registrationId,
    data: plaintext,
  })
  await session.detach()
}

export type Shown = { title: string; body: string; tag: string; data: unknown }

/** The page's service worker once the browser reports it running (it is started by a push or a message, and stops when idle). */
export async function runningWorker(context: BrowserContext, timeoutMs = 10_000): Promise<Worker> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [worker] = context.serviceWorkers()
    if (worker) return worker
    if (Date.now() > deadline) throw new Error('the service worker is not running')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** What the worker has on screen right now. */
export async function shownNotifications(context: BrowserContext): Promise<Shown[]> {
  const worker = await runningWorker(context)
  return await worker.evaluate(async () => {
    type Registration = {
      getNotifications(): Promise<
        Array<{ title: string; body: string; tag: string; data: unknown }>
      >
    }
    const registration = (self as unknown as { registration: Registration }).registration
    const list = await registration.getNotifications()
    return list.map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }))
  })
}

/** Who the worker believes is signed in on this browser: its own record, read from the database it keeps (src/sw/identity.ts). */
export async function workerIdentity(
  context: BrowserContext,
): Promise<{ userId: string; installationId: string } | undefined> {
  const worker = await runningWorker(context)
  return await worker.evaluate(
    () =>
      new Promise<{ userId: string; installationId: string } | undefined>((resolve, reject) => {
        const opening = indexedDB.open('chatapp-sw')
        opening.onerror = () => reject(opening.error)
        opening.onsuccess = () => {
          const database = opening.result
          if (!database.objectStoreNames.contains('identity')) {
            database.close()
            resolve(undefined)
            return
          }
          const reading = database.transaction('identity').objectStore('identity').get('current')
          reading.onerror = () => reject(reading.error)
          reading.onsuccess = () => {
            database.close()
            resolve(reading.result ?? undefined)
          }
        }
      }),
  )
}

export type TrackedEvent = 'push' | 'message'

/**
 * Starts counting the push and message events the worker handles, so that "nothing happened" can be told from "not looked at
 * yet". The worker hands its work for an event to `waitUntil`; this wraps that, and keeps a promise per event that ends when
 * the work has. (A worker the browser stops for being idle and starts again has forgotten this: call it again.)
 */
export async function trackEvents(context: BrowserContext): Promise<void> {
  const worker = await runningWorker(context)
  await worker.evaluate(() => {
    type Scope = {
      __handled?: Record<string, Promise<void>[]>
      ExtendableEvent: {
        prototype: { waitUntil(this: { type: string }, p: Promise<unknown>): void }
      }
    }
    const scope = self as unknown as Scope
    if (scope.__handled) return
    const handled: Record<string, Promise<void>[]> = { push: [], message: [] }
    scope.__handled = handled
    const prototype = scope.ExtendableEvent.prototype
    const original = prototype.waitUntil
    prototype.waitUntil = function (this: { type: string }, promise: Promise<unknown>): void {
      handled[this.type]?.push(
        Promise.resolve(promise).then(
          () => undefined,
          () => undefined,
        ),
      )
      original.call(this, promise)
    }
  })
}

/** How many events of this kind the worker has taken since `trackEvents`, once it has finished with all of them. */
export async function handledCount(context: BrowserContext, type: TrackedEvent): Promise<number> {
  const worker = await runningWorker(context)
  return await worker.evaluate(async (kind) => {
    const scope = self as unknown as { __handled?: Record<string, Promise<void>[]> }
    if (!scope.__handled) throw new Error('trackEvents() was not called for this worker')
    const list = scope.__handled[kind] ?? []
    await Promise.all(list)
    return list.length
  }, type)
}

/** Waits until the worker has taken at least `count` events of this kind and finished with all of them. */
export async function waitHandled(
  context: BrowserContext,
  type: TrackedEvent,
  count: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const finished = await handledCount(context, type)
    if (finished >= count) return
    if (Date.now() > deadline)
      throw new Error(
        `the worker handled ${finished} of ${count} ${type} events within ${timeoutMs} ms`,
      )
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * A click on the notification with this tag, as the browser reports it to the worker: the worker's own handler runs, and the
 * returned promise ends when what that handler passed to `waitUntil` has. (A click itself cannot be made by a test; the event
 * is made here, and given a `waitUntil` that keeps the work, because the browser refuses it on an event it did not dispatch.)
 */
export async function clickNotification(context: BrowserContext, tag: string): Promise<void> {
  const worker = await runningWorker(context)
  await worker.evaluate(async (wanted) => {
    type Scope = {
      registration: { getNotifications(filter: { tag: string }): Promise<unknown[]> }
      dispatchEvent(event: Event): boolean
      NotificationEvent: new (type: string, init: { notification: unknown }) => Event
    }
    const scope = self as unknown as Scope
    const [notification] = await scope.registration.getNotifications({ tag: wanted })
    if (!notification) throw new Error(`no notification with the tag ${wanted}`)
    const event = new scope.NotificationEvent('notificationclick', { notification })
    const kept: Promise<unknown>[] = []
    Object.defineProperty(event, 'waitUntil', {
      value: (promise: Promise<unknown>) => {
        kept.push(promise)
      },
    })
    scope.dispatchEvent(event)
    await Promise.all(kept)
  }, tag)
}
