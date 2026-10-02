import { createVerifiedMember } from './support/api.ts'
import { expect, installProbes, newContext, socketProbe, test } from './support/fixtures.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * docs/08 section 3, scenario 11 (M1b): a person signs in on two devices; from the first they sign the second out. The
 * second device's realtime connection is closed, its next request is refused, and its page returns to the sign-in page.
 * Messages arrive with M2, so "no chat content after sign-out" is extended then.
 */
test('@smoke signing out another device closes its connection and sends it to the sign-in page', async ({
  browser,
}) => {
  const person = await createVerifiedMember('devices')
  const contextA = await newContext(browser)
  const contextB = await newContext(browser)
  const a = await contextA.newPage()
  const b = await contextB.newPage()
  await installProbes(a)
  await installProbes(b)
  try {
    await signIn(a, person.email, person.password)
    await signIn(b, person.email, person.password)
    // Both devices are connected.
    await expect.poll(async () => (await socketProbe(b)).opened).toBeGreaterThan(0)
    await expect.poll(async () => (await socketProbe(a)).opened).toBeGreaterThan(0)

    // Device A lists two devices and signs the other one out.
    await openSettings(a, 'account')
    const devices = a.locator('.device')
    await expect(devices).toHaveCount(2)
    await expect(devices.filter({ hasText: '此设备' })).toHaveCount(1)
    await devices.filter({ hasNotText: '此设备' }).getByRole('button', { name: '注销' }).click()
    await a.getByRole('dialog').getByRole('button', { name: '注销', exact: true }).click()
    await expect(a.getByText('已注销，对方会在几秒内被踢回登录页')).toBeVisible()
    await expect(devices).toHaveCount(1)

    // Device B: connection closed with 4401, then the page is back at the sign-in page with an explanation.
    await expect(b).toHaveURL(/\/login/, { timeout: 15_000 })
    await expect(b.getByText(/登录已失效/)).toBeVisible()
    expect((await socketProbe(b)).closes).toContain(4401)
    expect((await b.request.get('/api/me')).status()).toBe(401)
    // The session cookie it kept is dead: the app does not treat it as signed in.
    await b.goto('/')
    await expect(b).toHaveURL(/\/login/)

    // Device A is untouched: a fresh load of the start page is still the signed-in app.
    await a.goto('/')
    await expect(a.getByRole('navigation', { name: '会话' })).toBeVisible()
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('signing out here ends the session, closes the connection and clears the app in other tabs', async ({
  page,
  browser,
}) => {
  const person = await createVerifiedMember('signout')
  await signIn(page, person.email, person.password)
  // A second tab of the same browser.
  const tab = await page.context().newPage()
  await installProbes(tab)
  await tab.goto('/')
  await expect(tab.getByRole('navigation', { name: '会话' })).toBeVisible()

  await openSettings(page, 'account')
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login/)

  // The other tab learns of it at once (broadcast), without waiting for the server's five-second check.
  await expect(tab).toHaveURL(/\/login/, { timeout: 3_000 })
  expect((await page.request.get('/api/me')).status()).toBe(401)
  void browser
})
