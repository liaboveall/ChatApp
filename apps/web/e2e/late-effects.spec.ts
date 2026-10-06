import type { Page } from '@playwright/test'
import { createVerifiedMember, type Person } from './support/api.ts'
import {
  createChannelApi,
  createGroupApi,
  memberRow,
  myId,
  openDetails,
  openDmApi,
  openFromSidebar,
  signedIn,
} from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import { holdAnswer, signInInPlace, signOutInPlace, watchText } from './support/late.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * What a screen does when the answer to its request comes back (jump to the new conversation, go home, say what was done)
 * belongs to the person who made the request (M2b recheck 2026-10-06, D-174, SEC-34; the same rule as D-171 and D-173 for
 * the cache and for the composer). The request goes out, the server does what was asked, and the answer is held back; the
 * person signs out, somebody else signs in, in the same page, and stands on a channel of their own; then the answer comes.
 * The page must neither take the new person anywhere nor tell them what the other one did, the names in it least of all.
 * The held answer is delivered, and the page is given its turn to act on it, before anything is asserted.
 */

const stamp = (): string => Date.now().toString(36)

/** Signs the first person out and the second one in, in the same page, and puts them on a channel of their own. */
async function nextPersonStands(page: Page, next: Person, channel: string): Promise<string> {
  await signOutInPlace(page)
  await signInInPlace(page, next.email, next.password)
  await openFromSidebar(page, channel)
  await expect(page).toHaveURL(/\/c\//)
  return page.url()
}

/** A channel of their own for the person who signs in later, made through the API. */
async function ownChannel(person: Person, label: string): Promise<string> {
  const name = `LE-${label}-${stamp()}`
  await createChannelApi(await signedIn(person), name)
  return name
}

test('D-174: the answer to creating a group does not take the person who signed in meanwhile to it', async ({
  page,
}) => {
  const alice = await createVerifiedMember('lenewa')
  const bob = await createVerifiedMember('lenewb')
  const own = await ownChannel(bob, 'newown')
  const name = `LE-group-${stamp()}`
  await signIn(page, alice.email, alice.password)

  const held = await holdAnswer(page, /\/api\/conversations$/, 'POST')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByRole('menuitem', { name: '新建群组' }).click()
  await page.getByLabel('名称').fill(name)
  await page.getByRole('dialog').getByRole('button', { name: '创建' }).click()
  await held.reached
  await page.keyboard.press('Escape')

  const where = await nextPersonStands(page, bob, own)
  await held.deliver()
  await expect(page).toHaveURL(where)
  await expect(page.locator('.toolbar__title')).toHaveText(own)
})

test('D-174: the answer to leaving a channel does not take the person who signed in meanwhile home', async ({
  page,
}) => {
  const alice = await createVerifiedMember('leleavea')
  const bob = await createVerifiedMember('leleaveb')
  const carol = await createVerifiedMember('leleavec')
  const apiA = await signedIn(alice)
  const name = `LE-leave-${stamp()}`
  const id = await createChannelApi(apiA, name)
  expect(
    (await (await signedIn(bob)).post(`/api/conversations/${id}/join`, { data: {} })).ok(),
  ).toBe(true)
  const own = await ownChannel(carol, 'leaveown')
  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await openDetails(page)

  const held = await holdAnswer(page, new RegExp(`/api/conversations/${id}/leave$`), 'POST')
  await page.getByRole('button', { name: '退出会话' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '退出', exact: true }).click()
  await held.reached
  // The page learns through the person's own log that the membership is gone and goes home by itself, answer or not.
  await expect(page).toHaveURL(/\/$/)

  const where = await nextPersonStands(page, carol, own)
  await held.deliver()
  await expect(page).toHaveURL(where)
  await expect(page.locator('.toolbar__title')).toHaveText(own)
})

test('D-174: the answer to archiving a group does not name it to, nor take home, the person who signed in meanwhile', async ({
  page,
}) => {
  const alice = await createVerifiedMember('learchivea')
  const dan = await createVerifiedMember('learchived')
  const carol = await createVerifiedMember('learchivec')
  const apiA = await signedIn(alice)
  const name = `LE-archive-${stamp()}`
  const id = await createGroupApi(apiA, name, [await myId(await signedIn(dan))])
  const own = await ownChannel(carol, 'archiveown')
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await openDetails(page)

  const held = await holdAnswer(page, new RegExp(`/api/conversations/${id}/archive$`), 'POST')
  await page.getByRole('button', { name: '归档会话' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '归档', exact: true }).click()
  await held.reached

  const where = await nextPersonStands(page, carol, own)
  const named = await watchText(page, '.toast', name)
  await held.deliver()
  expect(await named()).toBe(false)
  await expect(page.locator('.toast')).toHaveCount(0)
  await expect(page).toHaveURL(where)
})

test('D-174: the answer to lifting a ban does not name the person to whoever signed in meanwhile', async ({
  page,
}) => {
  const alice = await createVerifiedMember('leunbana')
  const dan = await createVerifiedMember('leunband')
  const carol = await createVerifiedMember('leunbanc')
  const apiA = await signedIn(alice)
  const danId = await myId(await signedIn(dan))
  const name = `LE-unban-${stamp()}`
  const id = await createGroupApi(apiA, name, [danId])
  expect(
    (
      await apiA.post(`/api/conversations/${id}/bans`, { data: { userId: danId, reason: '测试' } })
    ).ok(),
  ).toBe(true)
  const own = await ownChannel(carol, 'unbanown')
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await openDetails(page)
  await expect(page.getByRole('button', { name: '解除封禁' })).toBeVisible()

  const held = await holdAnswer(
    page,
    new RegExp(`/api/conversations/${id}/bans/${danId}$`),
    'DELETE',
  )
  await page.getByRole('button', { name: '解除封禁' }).click()
  await held.reached

  await nextPersonStands(page, carol, own)
  const named = await watchText(page, '.toast', dan.name)
  await held.deliver()
  expect(await named()).toBe(false)
  await expect(page.locator('.toast')).toHaveCount(0)
})

test('D-174: the answer to a change of a member does not name the member to whoever signed in meanwhile', async ({
  page,
}) => {
  const alice = await createVerifiedMember('lemembera')
  const bob = await createVerifiedMember('lememberb')
  const carol = await createVerifiedMember('lememberc')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `LE-member-${stamp()}`
  const id = await createGroupApi(apiA, name, [bobId])
  const own = await ownChannel(carol, 'memberown')
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await openDetails(page)

  const held = await holdAnswer(
    page,
    new RegExp(`/api/conversations/${id}/members/${bobId}$`),
    'PATCH',
  )
  await memberRow(page, bob.name)
    .getByRole('button', { name: /的操作/ })
    .click()
  await page.getByRole('menuitem', { name: '设为管理员' }).click()
  await held.reached

  await nextPersonStands(page, carol, own)
  const named = await watchText(page, '.toast', bob.name)
  await held.deliver()
  expect(await named()).toBe(false)
  await expect(page.locator('.toast')).toHaveCount(0)
})

test('D-174: the answer to hiding a direct message does not take the person who signed in meanwhile home', async ({
  page,
}) => {
  const alice = await createVerifiedMember('lehidea')
  const bob = await createVerifiedMember('lehideb')
  const carol = await createVerifiedMember('lehidec')
  const apiA = await signedIn(alice)
  const dm = await openDmApi(apiA, await myId(await signedIn(bob)))
  const own = await ownChannel(carol, 'hideown')
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, bob.name)
  await openDetails(page)

  const held = await holdAnswer(page, new RegExp(`/api/conversations/${dm}/me$`), 'PATCH')
  await page.getByRole('button', { name: '隐藏这个私信' }).click()
  await held.reached

  const where = await nextPersonStands(page, carol, own)
  await held.deliver()
  await expect(page).toHaveURL(where)
  await expect(page.locator('.toast')).toHaveCount(0)
})

test('D-174: the answer to joining from the channel list does not take the person who signed in meanwhile to the channel', async ({
  page,
}) => {
  const alice = await createVerifiedMember('lejoina')
  const bob = await createVerifiedMember('lejoinb')
  const carol = await createVerifiedMember('lejoinc')
  const name = `LE-join-${stamp()}`
  const id = await createChannelApi(await signedIn(alice), name)
  const own = await ownChannel(carol, 'joinown')
  await signIn(page, bob.email, bob.password)
  await page.goto('/channels')
  await page.getByLabel('搜索频道').fill(name)
  const row = page.locator('.list-row').filter({ hasText: name })
  await expect(row).toBeVisible()

  const held = await holdAnswer(page, new RegExp(`/api/conversations/${id}/join$`), 'POST')
  await row.getByRole('button', { name: '加入' }).click()
  await held.reached

  const where = await nextPersonStands(page, carol, own)
  await held.deliver()
  await expect(page).toHaveURL(where)
  await expect(page.locator('.toolbar__title')).toHaveText(own)
})

test('D-174: the answer to restoring an archived group does not take the person who signed in meanwhile to it', async ({
  page,
}) => {
  const alice = await createVerifiedMember('lerestorea')
  const carol = await createVerifiedMember('lerestorec')
  const apiA = await signedIn(alice)
  const name = `LE-restore-${stamp()}`
  const id = await createGroupApi(apiA, name, [])
  expect((await apiA.post(`/api/conversations/${id}/archive`, { data: {} })).ok()).toBe(true)
  const own = await ownChannel(carol, 'restoreown')
  await signIn(page, alice.email, alice.password)
  await page.goto('/archived')
  const row = page.locator('.list-row').filter({ hasText: name })
  await expect(row).toBeVisible()

  const held = await holdAnswer(page, new RegExp(`/api/conversations/${id}/restore$`), 'POST')
  await row.getByRole('button', { name: '恢复' }).click()
  await held.reached

  const where = await nextPersonStands(page, carol, own)
  await held.deliver()
  await expect(page).toHaveURL(where)
  await expect(page.locator('.toolbar__title')).toHaveText(own)
})

test('D-174: the answer to a change in the settings is not announced to the person who signed in meanwhile', async ({
  page,
}) => {
  const alice = await createVerifiedMember('lesettinga')
  const bob = await createVerifiedMember('lesettingb')
  await signIn(page, alice.email, alice.password)
  await openSettings(page, 'account')

  const held = await holdAnswer(page, /\/api\/me$/, 'PATCH', (body) =>
    (body ?? '').includes('timezoneAuto'),
  )
  await page.getByRole('radio', { name: '固定' }).click()
  await held.reached
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login/)
  await signInInPlace(page, bob.email, bob.password)

  const announced = await watchText(page, '.toast', '时区已更新')
  await held.deliver()
  expect(await announced()).toBe(false)
  await expect(page.locator('.toast')).toHaveCount(0)
})
