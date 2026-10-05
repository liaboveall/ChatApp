import { createVerifiedMember } from './support/api.ts'
import {
  composer,
  createGroupApi,
  memberRow,
  message,
  myId,
  openDetails,
  openFromSidebar,
  sendApi,
  sendFromComposer,
  signedIn,
} from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/**
 * docs/08 section 3, scenario 10 (M2b): D joins a group after it has a history. D sees nothing from before; a reply that
 * quotes an older message shows "original message not visible"; and once D has been removed and banned, the group's
 * invitation link no longer lets D in.
 */
test('@smoke D joins by link after a history: sees none of it, the old quote is hidden, and after a ban the link no longer works', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const dave = await createVerifiedMember('dave')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `历史群${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiA, name, [bobId])

  // A history: an old message, and a reply that quotes it.
  const old = await sendApi(apiA, groupId, '加入之前的旧消息')
  const apiB = await signedIn(bob)
  await sendApi(apiB, groupId, '引用旧消息的回复', old.id)

  // A makes a link in the details panel.
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await openDetails(page)
  await page.getByRole('button', { name: '创建链接' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  const link = await page.getByRole('textbox', { name: '邀请链接' }).inputValue()
  expect(link).toContain('/join#')
  await page.getByRole('dialog').getByRole('button', { name: '完成' }).click()

  // D follows the link, signed in, and opens the group.
  const daveContext = await newContext(browser)
  const d = await daveContext.newPage()
  await signIn(d, dave.email, dave.password)
  await d.goto(link)
  await expect(d.getByText(name)).toBeVisible()
  await d.getByRole('button', { name: '加入' }).click()
  await expect(d).toHaveURL(/\/c\//)
  await expect(composer(d)).toBeVisible()

  // Before the join is gone: the boundary says so, the old message is not there, the quote reads "not visible".
  await expect(d.getByText(/你于 .* 加入，之前的消息不可见/)).toBeVisible()
  await expect(d.getByText('加入之前的旧消息')).toHaveCount(0)
  // A new reply to the old message from A: D sees the reply, not what it quotes.
  await sendApi(apiA, groupId, '又一条回复', old.id)
  await expect(message(d, '又一条回复')).toBeVisible()
  await expect(message(d, '又一条回复').getByText('原消息不可见')).toBeVisible()
  await expect(d.getByText('加入之前的旧消息')).toHaveCount(0)
  // Everybody can see the new member, and D can talk.
  await sendFromComposer(d, '大家好，我是新来的')
  await expect(message(page, '大家好，我是新来的')).toBeVisible()

  // A removes and bans D from the member list.
  await expect(memberRow(page, dave.name)).toBeVisible()
  await memberRow(page, dave.name)
    .getByRole('button', { name: /的操作/ })
    .click()
  await page.getByRole('menuitem', { name: '移出并封禁…' }).click()
  await page.getByLabel(/原因/).fill('测试封禁')
  await page.getByRole('dialog').getByRole('button', { name: '移出并封禁', exact: true }).click()
  await expect(memberRow(page, dave.name)).toHaveCount(0)
  await expect(page.locator('.details .member').filter({ hasText: '测试封禁' })).toBeVisible()

  // D is out of the group at once, and the link is no use any more.
  await expect(d).toHaveURL(/\/$/, { timeout: 10_000 })
  await d.goto(link)
  // Refused with the ban's own words, whether the link is looked at or followed.
  const join = d.getByRole('button', { name: '加入' })
  const refusal = d.getByText(/你已被禁止加入这个会话。|你已被移出并禁止再次加入。/)
  await expect(join.or(refusal)).toBeVisible()
  if (await join.isVisible()) await join.click()
  await expect(refusal).toBeVisible()
  await expect(d).not.toHaveURL(/\/c\//)
})
