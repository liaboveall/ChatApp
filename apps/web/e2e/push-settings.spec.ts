import { createVerifiedMember } from './support/api.ts'
import { myId, openDmApi, sendApi, signedIn } from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import {
  capturedFor,
  decrypt,
  newBrowserKeys,
  newPushBrowser,
  SWITCH_HERE,
  turnOnPush,
  waitForCaptured,
} from './support/push.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * docs/01 section 4.10, M6: Settings → Notifications. What is pushed (three switches of the account, the lower two following
 * the first), this device (turn push on and off, send a test notification), the other devices of the account (list, remove),
 * and what the page says when the browser cannot or may not. The full Chromium build is used for the reason given in
 * scenario-9-push.spec.ts.
 */
test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'the push service is simulated through Chrome DevTools',
)
test.use({ channel: 'chromium' })

const toast = (page: import('@playwright/test').Page, text: string) =>
  page.locator('.toast').filter({ hasText: text })

test('what is pushed: the three switches of the account are kept, and the lower two follow the first', async ({
  browser,
}) => {
  const person = await createVerifiedMember('switches')
  const context = await newContext(browser)
  const page = await context.newPage()
  await signIn(page, person.email, person.password)
  await openSettings(page, 'notifications')

  const master = page.getByRole('switch', { name: '浏览器推送' })
  const assistant = page.getByRole('switch', { name: '助手相关' })
  const preview = page.getByRole('switch', { name: '在推送里显示内容' })
  // Out of the box: push on, the assistant's events on, and no content in notifications.
  await expect(master).toBeChecked()
  await expect(assistant).toBeChecked()
  await expect(preview).not.toBeChecked()

  await preview.click()
  await expect(preview).toBeChecked()
  await master.click()
  await expect(master).not.toBeChecked()
  // With push off for the account the other two have nothing to say.
  await expect(assistant).toBeDisabled()
  await expect(preview).toBeDisabled()

  // The server holds them: a fresh load of the page shows the same.
  await openSettings(page, 'notifications')
  await expect(master).not.toBeChecked()
  await expect(preview).toBeChecked()
  const me = (await (await page.request.get('/api/me')).json()) as {
    settings: Record<string, unknown>
  }
  expect(me.settings).toMatchObject({ pushEnabled: false, pushPreview: true })

  await master.click()
  await expect(master).toBeChecked()
  await expect(assistant).toBeEnabled()
  await assistant.click()
  await expect(assistant).not.toBeChecked()
  await openSettings(page, 'notifications')
  await expect(assistant).not.toBeChecked()
  await expect(master).toBeChecked()
})

test('this device: turn push on, send a test notification, turn it off', async ({
  browser,
  baseURL,
}) => {
  const person = await createVerifiedMember('device')
  const api = await signedIn(person)
  const keys = newBrowserKeys('device')
  const context = await newPushBrowser(browser, baseURL ?? '', keys)
  const page = await context.newPage()
  await signIn(page, person.email, person.password)
  await openSettings(page, 'notifications')

  const here = page.getByRole('switch', { name: SWITCH_HERE })
  const test = page.getByRole('button', { name: '发送测试通知' })
  await expect(here).toBeEnabled()
  await expect(here).not.toBeChecked()
  await expect(test).toBeDisabled()
  await expect(page.getByText('没有其他已订阅的设备。')).toBeVisible()

  await here.click()
  await expect(toast(page, '已在这台设备上开启推送')).toBeVisible()
  await expect(here).toBeChecked()
  await expect(page.getByText('已开启：就算关掉这个页面，新消息也会通知你。')).toBeVisible()
  await expect(test).toBeEnabled()

  // The test notification is a push like any other: it reaches the simulated push service, and says what it is.
  await test.click()
  await expect(toast(page, '测试通知已发出')).toBeVisible()
  const [captured] = await waitForCaptured(api, keys.endpoint)
  if (!captured) throw new Error('nothing was captured')
  const me = (await (await api.get('/api/me')).json()) as { id: string }
  expect(JSON.parse(decrypt(captured, keys))).toEqual({
    v: 1,
    userId: me.id,
    kind: 'test',
    title: 'ChatApp',
    body: '这是一条测试通知：这台设备可以收到推送。',
    url: '/',
    tag: 'test',
    unread: 0,
  })

  // Off again: the browser's subscription and the server's are both gone, and the page says so.
  await here.click()
  await expect(toast(page, '已关闭这台设备的推送')).toBeVisible()
  await expect(here).not.toBeChecked()
  await expect(test).toBeDisabled()
  expect(await page.evaluate(() => sessionStorage.getItem('e2e.fake-push'))).toBeNull()
  const left = (await (await api.get('/api/push/subscriptions')).json()) as {
    subscriptions: unknown[]
  }
  expect(left.subscriptions).toEqual([])
})

test('the other devices of the account are listed, and one can be removed from here', async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL ?? ''
  const alice = await createVerifiedMember('alice')
  const carol = await createVerifiedMember('carol')
  const apiAlice = await signedIn(alice)
  const carolId = await myId(await signedIn(carol))
  const mine = newBrowserKeys('mine')
  const theirs = newBrowserKeys('theirs')

  const first = await (await newPushBrowser(browser, origin, mine)).newPage()
  await signIn(first, carol.email, carol.password)
  await turnOnPush(first)
  const second = await (await newPushBrowser(browser, origin, theirs)).newPage()
  await signIn(second, carol.email, carol.password)
  await turnOnPush(second)

  // The first browser sees the second as another device, and itself only as "this device".
  await openSettings(first, 'notifications')
  const remove = first.getByRole('button', { name: /^移除设备 / })
  await expect(remove).toHaveCount(1)
  await expect(first.getByText('没有其他已订阅的设备。')).toHaveCount(0)

  const dm = await openDmApi(apiAlice, carolId)
  await sendApi(apiAlice, dm, '移除之前')
  await waitForCaptured(apiAlice, mine.endpoint)
  await waitForCaptured(apiAlice, theirs.endpoint)

  await remove.click()
  await expect(toast(first, '已移除该设备')).toBeVisible()
  await expect(first.getByText('没有其他已订阅的设备。')).toBeVisible()
  await expect(first.getByRole('switch', { name: SWITCH_HERE })).toBeChecked()

  // What was removed gets nothing more; what stays keeps getting pushes.
  await sendApi(apiAlice, dm, '移除之后')
  await waitForCaptured(apiAlice, mine.endpoint, 2)
  expect(await capturedFor(apiAlice, theirs.endpoint)).toHaveLength(1)
})

test('a browser that has refused notifications, or has no push at all, says so and cannot turn push on', async ({
  browser,
}) => {
  const person = await createVerifiedMember('refused')

  // The permission is "denied" in the browser's own site settings.
  const refusing = await newContext(browser)
  await refusing.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true })
  })
  const denied = await refusing.newPage()
  await signIn(denied, person.email, person.password)
  await openSettings(denied, 'notifications')
  await expect(denied.getByRole('switch', { name: SWITCH_HERE })).toBeDisabled()
  await expect(denied.getByText(/浏览器已拒绝通知权限/)).toBeVisible()

  // The browser has no Push API (Safari outside an installed app, for one).
  const without = await newContext(browser)
  await without.addInitScript(() => {
    Reflect.deleteProperty(window, 'PushManager')
  })
  const bare = await without.newPage()
  await signIn(bare, person.email, person.password)
  await openSettings(bare, 'notifications')
  await expect(bare.getByRole('switch', { name: SWITCH_HERE })).toBeDisabled()
  await expect(bare.getByText('这个浏览器不支持网页推送。')).toBeVisible()
  // The rest of the tab still works there: the account's switches are not tied to the device.
  await expect(bare.getByRole('switch', { name: '浏览器推送' })).toBeEnabled()
})
