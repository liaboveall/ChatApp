import { createVerifiedMember } from './support/api.ts'
import { expect, test } from './support/fixtures.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * Local data is tied to the account and the login (docs/03 section 11, D-070, SEC-34; AT-17, the part that M1b can
 * reach): whatever the browser holds for one person is gone when the next one signs in on the same browser.
 */
test('@smoke nothing of the first account is left when another person signs in on the same browser', async ({
  page,
}) => {
  const first = await createVerifiedMember('first')
  const second = await createVerifiedMember('second')

  await signIn(page, first.email, first.password)
  await openSettings(page, 'account') // loads and caches the first account's profile, devices and passkeys
  await expect(page.getByText(first.email)).toBeVisible()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login/)

  await signIn(page, second.email, second.password)
  await openSettings(page, 'account')
  await expect(page.getByText(second.email)).toBeVisible()

  const everything = await page.evaluate(() => {
    const dump = (storage: Storage) =>
      Object.keys(storage).map((key) => `${key}=${storage.getItem(key)}`)
    return [document.body.innerText, ...dump(localStorage), ...dump(sessionStorage)].join('\n')
  })
  for (const secret of [first.email, first.username, first.name]) {
    expect(everything, `leftover: ${secret}`).not.toContain(secret)
  }
})

test('a sign-in in another tab takes this tab from the sign-in page into the app', async ({
  page,
  context,
}) => {
  const person = await createVerifiedMember('twotabs')
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: /登录/ })).toBeVisible()

  const other = await context.newPage()
  await signIn(other, person.email, person.password)

  await expect(page).not.toHaveURL(/\/login/, { timeout: 5_000 })
  await expect(page.getByRole('heading', { name: /^欢迎回来/ })).toBeVisible()
})
