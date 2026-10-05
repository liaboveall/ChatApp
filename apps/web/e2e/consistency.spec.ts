import { createVerifiedMember } from './support/api.ts'
import {
  composer,
  createChannelApi,
  createGroupApi,
  message,
  myId,
  openDetails,
  openFromSidebar,
  sendApi,
  sidebarItem,
  signedIn,
} from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/**
 * What one person sees on several devices, and what the cache forgets (docs/05 section 3, D-150, M2b): reading, hiding a
 * message and pinning follow the person to their other devices through their own log; removal and leaving clear the
 * conversation's cache, and the history from before a join never comes back (D-035).
 */
test('@smoke reading, hiding and pinning on one device show up on the other', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `两台设备${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiA, name, [bobId])
  await sendApi(apiA, groupId, '要被隐藏的消息')
  await sendApi(apiA, groupId, '要保留的消息')

  // Bob on two devices: both start on the home page.
  const secondContext = await newContext(browser)
  const second = await secondContext.newPage()
  await signIn(page, bob.email, bob.password)
  await signIn(second, bob.email, bob.password)
  await expect(sidebarItem(page, name)).toHaveAccessibleName(/2 条未读/)
  await expect(sidebarItem(second, name)).toHaveAccessibleName(/2 条未读/)

  // Reading on the first clears the badge on the second, without touching it.
  await openFromSidebar(page, name)
  await expect(message(page, '要保留的消息')).toBeVisible()
  await expect(sidebarItem(second, name)).not.toHaveAccessibleName(/未读/, { timeout: 10_000 })

  // The second opens the same conversation, then the first hides a message "for me": it vanishes on the second.
  await openFromSidebar(second, name)
  await expect(message(second, '要被隐藏的消息')).toBeVisible()
  await message(page, '要被隐藏的消息').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '仅自己删除' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click()
  await expect(message(page, '要被隐藏的消息')).toHaveCount(0)
  await expect(message(second, '要被隐藏的消息')).toHaveCount(0, { timeout: 10_000 })
  await expect(message(second, '要保留的消息')).toBeVisible()
  // The other person still has it.
  await expect(
    message(
      await (async () => {
        const c = await newContext(browser)
        const p = await c.newPage()
        await signIn(p, alice.email, alice.password)
        await openFromSidebar(p, name)
        return p
      })(),
      '要被隐藏的消息',
    ),
  ).toBeVisible()

  // Pinning on the first moves the conversation to the pinned group on the second.
  await openDetails(page)
  await page.getByRole('switch', { name: '置顶' }).click()
  await expect(
    second
      .getByRole('navigation', { name: '会话' })
      .getByRole('region', { name: '置顶' })
      .getByRole('link', { name: new RegExp(`^${name}`) }),
  ).toBeVisible({ timeout: 10_000 })
})

test('removed while looking: the conversation goes, with a note, and its messages with it', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `被移出${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiA, name, [bobId])
  await sendApi(apiA, groupId, '你看得到的消息')

  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect(message(page, '你看得到的消息')).toBeVisible()
  const response = await apiA.delete(`/api/conversations/${groupId}/members/${bobId}`)
  expect(response.ok()).toBe(true)

  await expect(page).toHaveURL(/\/$/, { timeout: 15_000 })
  // Which note depends on which news reaches the page first: the read of the conversation that is refused (the page can only
  // say it has no access) or the entry in the person's own log (it was removed). Both are the true thing (D-150).
  await expect(page.getByText(/你已(被移出|无法访问)这个会话。/)).toBeVisible()
  await expect(sidebarItem(page, name)).toHaveCount(0)
  // Nothing of it is left to see: the address now says "not found" like any other.
  await page.goto(`/c/${groupId}`)
  await expect(page.getByText('找不到这个会话', { exact: true })).toBeVisible()
  await expect(page.getByText('你看得到的消息')).toHaveCount(0)
  void browser
})

test('leaving a channel and coming back: the time away and everything before are not visible', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const apiB = await signedIn(bob)
  const name = `去了又回${Date.now().toString(36)}`
  const channelId = await createChannelApi(apiA, name)
  await apiB.post(`/api/conversations/${channelId}/join`, { data: {} })
  await sendApi(apiA, channelId, '第一次加入时的消息')

  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect(message(page, '第一次加入时的消息')).toBeVisible()

  // Leaves from the details panel; A writes while B is away.
  await openDetails(page)
  await page.getByRole('button', { name: '退出会话' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '退出', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  await sendApi(apiA, channelId, '离开期间的消息')

  // Back from the directory: a new membership, a new boundary, nothing from before.
  await page.goto('/channels')
  await page.getByLabel('搜索频道').fill(name)
  await page
    .locator('.list-row')
    .filter({ hasText: name })
    .getByRole('button', { name: '加入' })
    .click()
  await expect(composer(page)).toBeVisible()
  await expect(page.getByText(/你于 .* 加入，之前的消息不可见/)).toBeVisible()
  await expect(message(page, '第一次加入时的消息')).toHaveCount(0)
  await expect(message(page, '离开期间的消息')).toHaveCount(0)
  await sendApi(apiA, channelId, '回来之后的消息')
  await expect(message(page, '回来之后的消息')).toBeVisible()
  void browser
})
