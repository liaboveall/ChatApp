import { newPerson } from './support/accounts.ts'
import { createVerifiedMember } from './support/api.ts'
import {
  createGroupApi,
  message,
  myId,
  openFromSidebar,
  sendApi,
  sendFromComposer,
  sidebarItem,
  signedIn,
} from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * The profile and the password in Settings (docs/01 section 4.3, D-133, M2b): the display name and bio change at once;
 * a username is refused when it is taken or reserved, can be changed once in 30 days and says so before it is saved;
 * and changing the password swaps the session underneath a running app, which carries on (D-150, `switchScope`).
 */
test('@smoke the display name and the bio can be changed', async ({ page }) => {
  const person = await createVerifiedMember('profile')
  await signIn(page, person.email, person.password)
  await openSettings(page, 'account')
  await page.getByRole('button', { name: '编辑资料…' }).click()
  await page.getByLabel('显示名').fill('新的显示名')
  await page.getByLabel('简介').fill('这是我的简介')
  await page.getByRole('dialog').getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('资料已保存')).toBeVisible()
  const profile = page.locator('.group').filter({ hasText: '资料' }).first()
  await expect(profile).toContainText('新的显示名')
  await expect(profile).toContainText('这是我的简介')
  // The sidebar's footer shows the new name too (the settings sheet has to be closed for the page behind it to be read).
  await page.keyboard.press('Escape')
  await expect(page.getByRole('navigation', { name: '会话' })).toContainText('新的显示名')
  const me = (await (await page.request.get('/api/me')).json()) as {
    displayName: string
    bio: string
  }
  expect(me.displayName).toBe('新的显示名')
  expect(me.bio).toBe('这是我的简介')
})

test('a username: refused when taken or reserved, warned about, changed once in 30 days', async ({
  page,
}) => {
  const person = await createVerifiedMember('rename')
  const other = await createVerifiedMember('taken')
  await signIn(page, person.email, person.password)
  await openSettings(page, 'account')
  const dialog = page.getByRole('dialog').filter({ hasText: '编辑资料' })
  const open = async (): Promise<void> => {
    await page.getByRole('button', { name: '编辑资料…' }).click()
    await expect(dialog).toBeVisible()
  }
  const save = (): Promise<void> => dialog.getByRole('button', { name: '保存' }).click()

  await open()
  // Not a valid name: the field says so before anything is sent.
  await dialog.getByLabel('用户名').fill('ab')
  await expect(dialog.getByText('用户名需要 3–20 位')).toBeVisible()
  // Somebody else's name.
  await dialog.getByLabel('用户名').fill(other.username)
  await save()
  await expect(dialog.getByText('这个用户名已被占用。')).toBeVisible()
  // A reserved name.
  await dialog.getByLabel('用户名').fill('admin')
  await save()
  await expect(dialog.getByText('这个用户名是保留名，不能使用。')).toBeVisible()
  // A good one: the dialog warns about the 30 days first, then it is saved.
  const fresh = newPerson('fresh').username
  await dialog.getByLabel('用户名').fill(fresh)
  await expect(dialog.getByText(/30 天内不能再改/)).toBeVisible()
  await save()
  await expect(page.getByText('资料已保存')).toBeVisible()
  await expect(page.locator('.group').first()).toContainText(`@${fresh}`)

  // Once is all there is for now.
  await open()
  await dialog.getByLabel('用户名').fill(newPerson('again').username)
  await save()
  await expect(dialog.getByText(/用户名每 30 天只能改一次/)).toBeVisible()
})

test('changing the password swaps the session under the running app, which carries on', async ({
  page,
}) => {
  const person = await createVerifiedMember('swap')
  const friend = await createVerifiedMember('friend')
  const apiP = await signedIn(person)
  const apiF = await signedIn(friend)
  const name = `换密码群${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiP, name, [await myId(apiF)])
  await sendApi(apiF, groupId, '换密码之前')

  await signIn(page, person.email, person.password)
  await openFromSidebar(page, name)
  await expect(message(page, '换密码之前')).toBeVisible()

  // Settings opened inside the running app (no reload), so the session really is swapped under a live screen.
  await page.keyboard.press('Control+,')
  await page.getByRole('dialog').getByText('账号', { exact: true }).click()
  await page.getByRole('button', { name: '修改密码…' }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: '修改密码' })
  await dialog.getByLabel('当前密码').fill(person.password)
  await dialog
    .getByLabel('新密码')
    .fill(`Zq9-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}-orchard`)
  await dialog.getByRole('button', { name: '修改密码' }).click()
  await expect(page.getByText(/密码已修改/)).toBeVisible()
  await page.keyboard.press('Escape')

  // Still signed in, the conversation and its messages are still there, and new ones arrive live and can be sent.
  await expect(sidebarItem(page, name)).toBeVisible()
  await expect(message(page, '换密码之前')).toBeVisible()
  await sendApi(apiF, groupId, '换密码之后')
  await expect(message(page, '换密码之后')).toBeVisible()
  await sendFromComposer(page, '换完密码我也能发')
  await expect(message(page, '换完密码我也能发')).toBeVisible()
  await expect(page.locator('[data-pending]')).toHaveCount(0)
})
