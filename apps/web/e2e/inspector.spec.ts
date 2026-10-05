import { adminCredentials } from './support/accounts.ts'
import { createVerifiedMember } from './support/api.ts'
import {
  composer,
  createGroupApi,
  memberRow,
  myId,
  openDetails,
  openFromSidebar,
  sidebarItem,
  signedIn,
} from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/**
 * The details panel of a conversation (docs/01 section 5, M2b): what each role can do with the members, the settings,
 * the invitation links, the bans and the way out. The server decides again with every call; these tests are about what
 * the interface offers and what it does with the answers.
 */
test('@smoke the owner manages a group from the details panel: add, skip, roles, silence, settings, hand over, leave', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const carol = await createVerifiedMember('carol')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `管理群${Date.now().toString(36)}`
  await createGroupApi(apiA, name, [bobId])

  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await openDetails(page)
  await expect(page.locator('.details__name')).toHaveText(name)
  await expect(memberRow(page, alice.name)).toContainText('群主')
  await expect(memberRow(page, alice.name)).toContainText('（你）')
  await expect(page.locator('#members-title')).toContainText('2')

  // Add carol with the picker.
  await page.getByRole('button', { name: '添加成员' }).first().click()
  await page.getByLabel('搜索要添加的成员').fill(carol.username)
  await page
    .locator('.person')
    .filter({ hasText: `@${carol.username}` })
    .click()
  await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click()
  await expect(memberRow(page, carol.name)).toBeVisible()
  await expect(page.locator('#members-title')).toContainText('3')

  // Add bob again: he is skipped, and the dialog says why instead of closing silently.
  await page.getByRole('button', { name: '添加成员' }).first().click()
  await page.getByLabel('搜索要添加的成员').fill(bob.username)
  await page
    .locator('.person')
    .filter({ hasText: `@${bob.username}` })
    .click()
  await page.getByRole('dialog').getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.getByText(`${bob.name} 已经是成员。`)).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '完成' }).click()

  // Roles: bob becomes an administrator.
  await memberRow(page, bob.name)
    .getByRole('button', { name: /的操作/ })
    .click()
  await page.getByRole('menuitem', { name: '设为管理员' }).click()
  await expect(memberRow(page, bob.name)).toContainText('管理员')

  // Silence carol: she sees the notice in place of the field; lifting it brings the field back.
  const carolContext = await newContext(browser)
  const c = await carolContext.newPage()
  await signIn(c, carol.email, carol.password)
  await openFromSidebar(c, name)
  await memberRow(page, carol.name)
    .getByRole('button', { name: /的操作/ })
    .click()
  await page.getByRole('menuitem', { name: '禁言…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '禁言', exact: true }).click()
  await expect(memberRow(page, carol.name)).toContainText('已禁言至')
  await expect(c.getByText('你已被禁言，暂时不能发言。')).toBeVisible()
  await memberRow(page, carol.name)
    .getByRole('button', { name: /的操作/ })
    .click()
  await page.getByRole('menuitem', { name: '解除禁言' }).click()
  await expect(composer(c)).toBeVisible()

  // Settings: a new name and description show in the toolbar and survive a reload.
  const renamed = `${name}改`
  await page.getByLabel('名称', { exact: true }).fill(renamed)
  await page.getByLabel('简介').fill('改过的简介')
  await page
    .locator('.dsec')
    .filter({ hasText: '会话设置' })
    .getByRole('button', { name: '保存' })
    .click()
  await expect(page.locator('.toolbar__title')).toHaveText(renamed)
  await page.reload()
  await openDetails(page)
  await expect(page.locator('.details__name')).toHaveText(renamed)
  await expect(page.locator('.details__text')).toHaveText('改过的简介')

  // An owner who is not alone cannot leave: the button waits, and says why. Hand over to bob, then leave.
  await expect(page.getByRole('button', { name: '退出会话' })).toBeDisabled()
  await expect(page.getByText('你是群主。要退出，请先在成员列表里把群主转让给别人。')).toBeVisible()
  await memberRow(page, bob.name)
    .getByRole('button', { name: /的操作/ })
    .click()
  await page.getByRole('menuitem', { name: '转让群主…' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '转让' }).click()
  await expect(memberRow(page, bob.name)).toContainText('群主')
  await expect(page.getByRole('button', { name: '归档会话' })).toHaveCount(0)
  await page.getByRole('button', { name: '退出会话' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '退出', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await expect(sidebarItem(page, renamed)).toHaveCount(0)
  // The others are still in it, under its new name.
  await expect(c.locator('.toolbar__title')).toHaveText(renamed)
})

test('a plain member sees what a member may do, and only what the group allows', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `权限群${Date.now().toString(36)}`
  await createGroupApi(apiA, name, [bobId])

  const bobContext = await newContext(browser)
  const b = await bobContext.newPage()
  await signIn(b, bob.email, bob.password)
  await openFromSidebar(b, name)
  await openDetails(b)
  // By default a member may bring people in and make links; nothing else of the management is there.
  await expect(b.getByRole('button', { name: '添加成员' }).first()).toBeVisible()
  await expect(b.getByRole('button', { name: '创建链接' })).toBeVisible()
  await expect(b.locator('.details .member').getByRole('button', { name: /的操作/ })).toHaveCount(0)
  await expect(b.getByRole('heading', { name: '会话设置' })).toHaveCount(0)
  await expect(b.getByRole('heading', { name: '封禁名单' })).toHaveCount(0)
  await expect(b.getByRole('button', { name: '归档会话' })).toHaveCount(0)
  await expect(b.getByRole('button', { name: '退出会话' })).toBeEnabled()

  // The owner restricts inviting to administrators: the member's panel follows without a reload.
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await openDetails(page)
  await page.getByLabel('谁可以添加成员').selectOption('admins_only')
  await page
    .locator('.dsec')
    .filter({ hasText: '会话设置' })
    .getByRole('button', { name: '保存' })
    .click()
  await expect(page.getByText('已保存').first()).toBeVisible()
  await expect(b.getByRole('button', { name: '添加成员' })).toHaveCount(0)
  await expect(b.getByRole('button', { name: '创建链接' })).toHaveCount(0)
})

test('a site administrator looks after a group without being in it: members and bans yes, messages and joining no', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `管理员看护${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiA, name, [bobId])

  const admin = adminCredentials()
  const adminContext = await newContext(browser)
  const a = await adminContext.newPage()
  await signIn(a, admin.email, admin.password)
  await a.goto(`/c/${groupId}`)
  await expect(a.getByRole('heading', { name })).toBeVisible()
  await expect(a.getByText(/你是站点管理员/)).toBeVisible()
  // No composer, no way to read, no "join" for a group; the details are there.
  await expect(composer(a)).toHaveCount(0)
  await expect(a.getByRole('button', { name: '加入' })).toHaveCount(0)
  await openDetails(a)
  await expect(memberRow(a, bob.name)).toBeVisible()
  await expect(memberRow(a, bob.name).getByRole('button', { name: /的操作/ })).toBeVisible()
  await expect(a.getByRole('heading', { name: '会话设置' })).toBeVisible()
  await expect(a.getByRole('heading', { name: '封禁名单' })).toBeVisible()
  await expect(a.getByRole('button', { name: '添加成员' })).toHaveCount(0)
  await expect(a.getByRole('button', { name: '退出会话' })).toHaveCount(0)
  await expect(a.getByRole('heading', { name: '我的设置' })).toHaveCount(0)

  // The administrator archives it; the members are told by the composer.
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await a.getByRole('button', { name: '归档会话' }).click()
  await a.getByRole('alertdialog').getByRole('button', { name: '归档', exact: true }).click()
  await expect(page.getByText('这个会话已归档，只能查看。')).toBeVisible()
})
