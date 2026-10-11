import { createVerifiedMember } from './support/api.ts'
import { myId, signedIn } from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import {
  deliverToWorker,
  handledCount,
  newBrowserKeys,
  newPushBrowser,
  runningWorker,
  shownNotifications,
  trackEvents,
  turnOnPush,
  waitHandled,
  workerIdentity,
} from './support/push.ts'
import { signIn } from './support/ui.ts'

test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'the real worker receives push events through Chrome DevTools',
)
test.use({ channel: 'chromium' })

test('a subscription renewal that waits through identity handover cannot register for the next account', async ({
  browser,
  baseURL,
}) => {
  const keys = newBrowserKeys('renewal')
  const context = await newPushBrowser(browser, baseURL ?? '', keys)
  const page = await context.newPage()
  await page.goto('/')
  await page.evaluate(() => navigator.serviceWorker.ready)
  const worker = await runningWorker(context)
  const identify = async (userId: string) => {
    await page.evaluate(async (userId) => {
      const registration = await navigator.serviceWorker.ready
      registration.active?.postMessage({
        type: 'identity',
        userId,
        installationId: '00000000-0000-4000-8000-000000000001',
      })
    }, userId)
    await expect.poll(() => workerIdentity(context)).toMatchObject({ userId })
  }
  await identify('00000000-0000-4000-8000-000000000002')
  await worker.evaluate(
    ({ endpoint, p256dh, auth }) => {
      const scope = self as unknown as {
        registration: { pushManager: { subscribe(): Promise<unknown> } }
        fetch: typeof fetch
        __renewRelease?: () => void
        __renewDone?: Promise<unknown>
        __renewRequests: number
      }
      scope.__renewRequests = 0
      const fetchOriginal = scope.fetch.bind(self)
      scope.fetch = async (url, options) => {
        if (url !== '/api/push/subscriptions') return fetchOriginal(url, options)
        scope.__renewRequests += 1
        return new Response('{}')
      }
      scope.registration.pushManager.subscribe = async () => {
        await new Promise<void>((resolve) => {
          scope.__renewRelease = resolve
        })
        return { toJSON: () => ({ endpoint, keys: { p256dh, auth } }) }
      }
      const event = new Event('pushsubscriptionchange')
      Object.defineProperty(event, 'waitUntil', {
        value: (promise: Promise<unknown>) => {
          scope.__renewDone = promise
        },
      })
      self.dispatchEvent(event)
    },
    { endpoint: keys.endpoint, p256dh: keys.p256dh, auth: keys.auth },
  )
  await expect
    .poll(() =>
      worker.evaluate(() =>
        Boolean((self as unknown as { __renewRelease?: unknown }).__renewRelease),
      ),
    )
    .toBe(true)
  await identify('00000000-0000-4000-8000-000000000003')
  await worker.evaluate(async () => {
    const scope = self as unknown as { __renewRelease: () => void; __renewDone: Promise<unknown> }
    scope.__renewRelease()
    await scope.__renewDone
  })
  expect(
    await worker.evaluate(() => (self as unknown as { __renewRequests: number }).__renewRequests),
  ).toBe(0)
  expect(await workerIdentity(context)).toMatchObject({
    userId: '00000000-0000-4000-8000-000000000003',
  })
})

test('a foreign push without a known identity cannot guess ownership and unsubscribe the installation', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL ?? ''
  const context = await newPushBrowser(browser, origin, newBrowserKeys('unknown'))
  const page = await context.newPage()
  await page.goto('/')
  await page.evaluate(() => navigator.serviceWorker.ready)
  expect(await workerIdentity(context)).toBeUndefined()
  const worker = await runningWorker(context)
  await worker.evaluate(() => {
    const scope = self as unknown as {
      registration: { pushManager: { getSubscription(): Promise<unknown> } }
      __unsubscribed: number
    }
    scope.__unsubscribed = 0
    scope.registration.pushManager.getSubscription = async () => ({
      unsubscribe: async () => {
        scope.__unsubscribed += 1
        return true
      },
    })
  })
  await trackEvents(context)
  await deliverToWorker(
    context,
    page,
    origin,
    JSON.stringify({
      v: 1,
      userId: 'previous-account',
      kind: 'message',
      title: 'ChatApp',
      body: 'old push',
      url: '/c/00000000-0000-4000-8000-000000000001',
      tag: 'old',
      unread: 1,
    }),
  )
  await waitHandled(context, 'push', 1)
  expect(
    await worker.evaluate(() => (self as unknown as { __unsubscribed: number }).__unsubscribed),
  ).toBe(0)
  expect(await shownNotifications(context)).toEqual([])
})

for (const delayed of [false, true]) {
  test(`a new identity closes the previous account's ${delayed ? 'in-flight' : 'already displayed'} notification even if logout cleanup was abandoned`, async ({
    browser,
    baseURL,
  }) => {
    const origin = baseURL ?? ''
    const first = await createVerifiedMember('handoffa')
    const second = await createVerifiedMember('handoffb')
    const firstId = await myId(await signedIn(first))
    const secondId = await myId(await signedIn(second))
    const context = await newPushBrowser(browser, origin, newBrowserKeys('handoff'))
    const page = await context.newPage()
    await signIn(page, first.email, first.password)
    await turnOnPush(page)
    await expect.poll(() => workerIdentity(context)).toMatchObject({ userId: firstId })
    await trackEvents(context)
    const worker = await runningWorker(context)

    if (delayed) {
      // Hold the real display, after the old identity was read. Handover must run after it finishes so that its late
      // notification is also closed; a guard checked only before the display would leave this one on screen.
      await worker.evaluate(() => {
        type Scope = {
          registration: {
            showNotification(title: string, options?: NotificationOptions): Promise<void>
          }
          __showEntered: boolean
          __releaseShow?: () => void
        }
        const scope = self as unknown as Scope
        const original = scope.registration.showNotification.bind(scope.registration)
        scope.__showEntered = false
        scope.registration.showNotification = async (title, options) => {
          scope.__showEntered = true
          await new Promise<void>((resolve) => {
            scope.__releaseShow = resolve
          })
          await original(title, options)
        }
      })
    }

    const holder = await context.newPage()
    await deliverToWorker(
      context,
      holder,
      origin,
      JSON.stringify({
        v: 1,
        userId: firstId,
        kind: 'message',
        title: 'ChatApp',
        body: '前一个账号的通知',
        url: '/c/00000000-0000-4000-8000-000000000001',
        tag: 'handoff-old',
        unread: 1,
      }),
    )
    if (delayed) {
      await expect
        .poll(() =>
          worker.evaluate(() => (self as unknown as { __showEntered: boolean }).__showEntered),
        )
        .toBe(true)
    } else {
      await waitHandled(context, 'push', 1)
      expect((await shownNotifications(context)).map((notice) => notice.tag)).toEqual([
        'handoff-old',
      ])
    }

    // The old page's logout never reached the worker; the new page's identity must complete the handover itself.
    const messages = await handledCount(context, 'message')
    await page.evaluate(async (userId) => {
      const registration = await navigator.serviceWorker.ready
      registration.active?.postMessage({ type: 'identity', userId, installationId: 'handoff' })
    }, secondId)
    if (delayed) {
      await worker.evaluate(() =>
        (self as unknown as { __releaseShow?: () => void }).__releaseShow?.(),
      )
    }
    await waitHandled(context, 'message', messages + 1)
    await waitHandled(context, 'push', 1)
    expect(await workerIdentity(context)).toMatchObject({ userId: secondId })
    expect(await shownNotifications(context)).toEqual([])
  })
}
