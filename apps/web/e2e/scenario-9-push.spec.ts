import { createVerifiedMember } from './support/api.ts'
import { createGroupApi, message, myId, openDmApi, sendApi, signedIn } from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import {
  capturedFor,
  clickNotification,
  decrypt,
  deliverToWorker,
  handledCount,
  newBrowserKeys,
  newPushBrowser,
  runningWorker,
  SWITCH_HERE,
  shownNotifications,
  trackEvents,
  turnOnPush,
  verifyVapid,
  waitForCaptured,
  waitHandled,
  workerIdentity,
} from './support/push.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * docs/08 section 3, scenario 9 (M6) and AT-17: a push reaches a person whose page is closed, a click on it opens the place it
 * names, and a browser that changes hands never shows the previous person's push. The push service is simulated
 * (support/push.ts): the server's worker records the encrypted request it would have sent, the test decrypts it as a browser
 * would, checks the VAPID signature, and gives it to the real service worker through Chrome DevTools, which is why only
 * Chromium runs these. The full Chromium build is used (`channel`): the headless shell reports every notification permission
 * as denied to the page, and a person's page is where the permission is asked for.
 */
test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'a push can only be handed to the worker through Chrome DevTools',
)
test.use({ channel: 'chromium' })

const payloadFor = (userId: string, conversationId: string): string =>
  JSON.stringify({
    v: 1,
    userId,
    kind: 'message',
    title: 'ChatApp',
    body: '你有新消息',
    url: `/c/${conversationId}`,
    tag: `c-${conversationId}`,
    unread: 1,
  })

test('scenario 9: C closes the page and still gets a push for a direct message, which says nothing of its content', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL ?? ''
  const alice = await createVerifiedMember('alice')
  const carol = await createVerifiedMember('carol')
  const apiAlice = await signedIn(alice)
  const apiCarol = await signedIn(carol)
  const carolId = await myId(apiCarol)
  const keys = newBrowserKeys('carol')

  const context = await newPushBrowser(browser, origin, keys)
  const page = await context.newPage()
  await signIn(page, carol.email, carol.password)
  await turnOnPush(page)

  // The server knows exactly one browser of C, and the worker knows whose pushes it may show.
  const list = await apiCarol.get('/api/push/subscriptions')
  expect(((await list.json()) as { subscriptions: unknown[] }).subscriptions).toHaveLength(1)
  await expect.poll(() => workerIdentity(context)).toMatchObject({ userId: carolId })
  await trackEvents(context)

  // C closes the page. A blank tab is left, to hold the connection to the browser's debugging port.
  const holder = await context.newPage()
  await page.close()

  const dm = await openDmApi(apiAlice, carolId)
  const secret = '这条消息的内容不该出现在推送里'
  await sendApi(apiAlice, dm, secret)
  const [captured] = await waitForCaptured(apiAlice, keys.endpoint)
  if (!captured) throw new Error('nothing was captured')

  // What reached the push service: encrypted, signed with the server's key, with the delivery hints (RFC 8030, 8291, 8292).
  const vapidKey = (
    (await (await apiCarol.get('/api/push/vapid-key')).json()) as { publicKey: string }
  ).publicKey
  const claims = verifyVapid(captured.headers.Authorization ?? '', vapidKey)
  expect(claims).not.toBeNull()
  expect(claims?.aud).toBe('https://fcm.googleapis.com')
  expect(claims?.sub).toMatch(/^mailto:/)
  expect(captured.headers['Content-Encoding']).toBe('aes128gcm')
  expect(captured.headers.TTL).toBe('86400')
  expect(captured.headers.Urgency).toBe('normal')
  expect(captured.headers.Topic).toMatch(/^[\w-]{1,32}$/)
  expect(JSON.stringify(captured)).not.toContain(secret)

  // What the browser reads once it has decrypted it: where to go and how many are waiting, and nothing of the message.
  const plaintext = decrypt(captured, keys)
  expect(JSON.parse(plaintext)).toEqual({
    v: 1,
    userId: carolId,
    kind: 'message',
    title: 'ChatApp',
    body: '你有新消息',
    url: `/c/${dm}`,
    tag: `c-${dm}`,
    unread: 1,
  })
  expect(plaintext).not.toContain(secret)
  expect(plaintext).not.toContain(alice.name)

  // The real worker shows it, with those words and nothing more.
  await deliverToWorker(context, holder, origin, plaintext)
  await waitHandled(context, 'push', 1)
  const shown = await shownNotifications(context)
  expect(shown).toHaveLength(1)
  expect(shown[0]).toMatchObject({ title: 'ChatApp', body: '你有新消息', tag: `c-${dm}` })
  expect(JSON.stringify(shown)).not.toContain(secret)
})

test('a click on the notification goes to the conversation in the window that is open', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL ?? ''
  const alice = await createVerifiedMember('alice')
  const carol = await createVerifiedMember('carol')
  const carolId = await myId(await signedIn(carol))
  const apiAlice = await signedIn(alice)
  const group = await createGroupApi(apiAlice, `点击组${Date.now().toString(36)}`, [carolId])
  const text = '点开通知后应该看到这条'
  await sendApi(apiAlice, group, text)

  const context = await newPushBrowser(browser, origin, newBrowserKeys('click'))
  const page = await context.newPage()
  await signIn(page, carol.email, carol.password)
  // The first visit installs the worker; the shell tells it who is here at the next load.
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await expect(page.getByRole('heading', { name: /^欢迎回来/ })).toBeVisible()
  await expect.poll(() => workerIdentity(context)).toMatchObject({ userId: carolId })
  await trackEvents(context)

  const holder = await context.newPage()
  await deliverToWorker(context, holder, origin, payloadFor(carolId, group))
  await waitHandled(context, 'push', 1)
  expect((await shownNotifications(context)).map((n) => n.tag)).toEqual([`c-${group}`])

  // The click closes the notification and the open window goes where it said.
  await clickNotification(context, `c-${group}`)
  await expect(page).toHaveURL(new RegExp(`/c/${group}$`))
  await expect(message(page, text)).toBeVisible()
  expect(await shownNotifications(context)).toEqual([])
})

test("AT-17: when C signs out and B signs in on the same browser, C's pushes stop for it and are never shown to B", async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL ?? ''
  const alice = await createVerifiedMember('alice')
  const carol = await createVerifiedMember('carol')
  const bob = await createVerifiedMember('bob')
  const apiAlice = await signedIn(alice)
  const apiCarol = await signedIn(carol)
  const carolId = await myId(apiCarol)
  const shared = newBrowserKeys('shared')
  const other = newBrowserKeys('other')

  // C has two browsers: the shared one, and one that stays signed in.
  const sharedBrowser = await newPushBrowser(browser, origin, shared)
  const page = await sharedBrowser.newPage()
  await signIn(page, carol.email, carol.password)
  await turnOnPush(page)
  const otherBrowser = await newPushBrowser(browser, origin, other)
  const otherPage = await otherBrowser.newPage()
  await signIn(otherPage, carol.email, carol.password)
  await turnOnPush(otherPage)
  const subscriptions = async () =>
    (
      (await (await apiCarol.get('/api/push/subscriptions')).json()) as {
        subscriptions: unknown[]
      }
    ).subscriptions.length
  await expect.poll(subscriptions).toBe(2)
  await expect.poll(() => workerIdentity(sharedBrowser)).toMatchObject({ userId: carolId })
  await trackEvents(sharedBrowser)

  // A push for C is on the screen of the shared browser.
  const dm = await openDmApi(apiAlice, carolId)
  await sendApi(apiAlice, dm, '签出之前的消息')
  const [before] = await waitForCaptured(apiAlice, shared.endpoint)
  if (!before) throw new Error('nothing was captured')
  const holder = await sharedBrowser.newPage()
  await deliverToWorker(sharedBrowser, holder, origin, decrypt(before, shared))
  await waitHandled(sharedBrowser, 'push', 1)
  expect((await shownNotifications(sharedBrowser)).map((n) => n.tag)).toEqual([`c-${dm}`])

  // C signs out of the shared browser: the worker forgets C, the notification goes, the browser's subscription is dropped,
  // and the server no longer has it (it belonged to the session that ended).
  await openSettings(page, 'account')
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect.poll(() => workerIdentity(sharedBrowser)).toBeUndefined()
  await expect.poll(async () => (await shownNotifications(sharedBrowser)).length).toBe(0)
  expect(await page.evaluate(() => sessionStorage.getItem('e2e.fake-push'))).toBeNull()
  await expect.poll(subscriptions).toBe(1)

  // B signs in on it. A later message for C goes to the browser C still uses, and not to the one that changed hands.
  const bobId = await myId(await signedIn(bob))
  await signIn(page, bob.email, bob.password)
  await expect.poll(() => workerIdentity(sharedBrowser)).toMatchObject({ userId: bobId })
  await turnOnPush(page)
  // The real worker's PushManager is separate from the page-side fake. Count any unsubscribe there too: an old payload
  // must be ignored without dropping the subscription the next account has just made.
  await (await runningWorker(sharedBrowser)).evaluate(() => {
    const scope = self as unknown as {
      registration: { pushManager: { getSubscription: () => Promise<unknown> } }
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
  await sendApi(apiAlice, dm, '签出之后的消息')
  await waitForCaptured(apiAlice, other.endpoint, 2)
  expect(await capturedFor(apiAlice, shared.endpoint)).toHaveLength(1)

  // A push for C that was already on its way arrives at the worker: it is not shown to B, whose browser this is.
  await deliverToWorker(sharedBrowser, holder, origin, payloadFor(carolId, dm))
  await waitHandled(sharedBrowser, 'push', 2)
  expect(await shownNotifications(sharedBrowser)).toEqual([])
  expect(
    await (await runningWorker(sharedBrowser)).evaluate(
      () => (self as unknown as { __unsubscribed: number }).__unsubscribed,
    ),
  ).toBe(0)

  // A sign-out message of C's, sent by one of C's tabs that was frozen until B had signed in, is not about B.
  const messages = await handledCount(sharedBrowser, 'message')
  await page.evaluate(async (userId) => {
    const registration = await navigator.serviceWorker.ready
    registration.active?.postMessage({ type: 'signed-out', userId })
  }, carolId)
  await waitHandled(sharedBrowser, 'message', messages + 1)
  expect(await workerIdentity(sharedBrowser)).toMatchObject({ userId: bobId })

  // B is still served: a push for B is shown, and the subscription B deliberately made is still enabled.
  const dmBob = await openDmApi(apiAlice, bobId)
  await deliverToWorker(sharedBrowser, holder, origin, payloadFor(bobId, dmBob))
  await waitHandled(sharedBrowser, 'push', 3)
  expect((await shownNotifications(sharedBrowser)).map((n) => n.tag)).toEqual([`c-${dmBob}`])
  await openSettings(page, 'notifications')
  await expect(page.getByRole('switch', { name: SWITCH_HERE })).toBeChecked()
})
