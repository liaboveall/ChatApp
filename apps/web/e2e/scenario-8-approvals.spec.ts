import { createVerifiedMember } from './support/api.ts'
import { createGroupApi, myId, openFromSidebar, signedIn } from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

test('M5 scenario 8: modify and approve a delegated message, both members see one message, regeneration is unavailable', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('approve'),
    bob = await createVerifiedMember('reader')
  const a = await signedIn(alice),
    b = await signedIn(bob)
  const name = `审批代发${Date.now().toString(36)}`,
    id = await createGroupApi(a, name, [await myId(b)])
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  const context = await newContext(browser),
    peer = await context.newPage()
  await signIn(peer, bob.email, bob.password)
  await openFromSidebar(peer, name)
  await page.getByRole('button', { name: '助手面板', exact: true }).click()
  const panel = page.locator('.agent-panel')
  await panel
    .getByRole('textbox', { name: '告诉助手你需要什么' })
    .fill('代发：原始草稿，请大家检查。')
  await panel.getByRole('button', { name: '询问助手', exact: true }).click()
  const approval = panel.getByRole('region', { name: `以你的身份发送到 ${name}` })
  await expect(approval).toBeVisible()
  await expect(panel).toContainText('等待你批准')
  await expect(peer.locator('.timeline')).not.toContainText('原始草稿')
  await approval.getByRole('button', { name: '修改', exact: true }).click()
  await approval.getByRole('textbox', { name: '修改内容' }).fill('最终稿：周五上午九点集合。')
  await approval.getByRole('button', { name: '保存并批准', exact: true }).click()
  await expect(approval).toContainText('已按你的修改批准')
  const sent = peer.getByRole('article').filter({ hasText: '最终稿：周五上午九点集合。' })
  await expect(sent).toHaveCount(1)
  await expect(sent).toContainText('经助手代发')
  await expect(panel.getByRole('button', { name: '重新生成', exact: true })).toHaveCount(0)
  const messages = await (await b.get(`/api/conversations/${id}/messages`)).json()
  expect(
    messages.messages.filter((m: { body: string }) => m.body === '最终稿：周五上午九点集合。'),
  ).toHaveLength(1)
  await peer.reload()
  await expect(sent).toHaveCount(1)
  await expect(peer.locator('.timeline')).not.toContainText('原始草稿')
  await a.dispose()
  await b.dispose()
})

test('M5 scenario 8: refusing an approval leaves the group untouched and survives reload', async ({
  page,
}) => {
  const alice = await createVerifiedMember('refuse'),
    a = await signedIn(alice)
  const name = `拒绝代发${Date.now().toString(36)}`,
    id = await createGroupApi(a, name)
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await page.getByRole('button', { name: '助手面板', exact: true }).click()
  const panel = page.locator('.agent-panel')
  await panel.getByRole('textbox', { name: '告诉助手你需要什么' }).fill('代发：这条不应发送。')
  await panel.getByRole('button', { name: '询问助手', exact: true }).click()
  const approval = panel.getByRole('region', { name: `以你的身份发送到 ${name}` })
  await approval.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(approval).toContainText('已拒绝')
  expect((await (await a.get(`/api/conversations/${id}/messages`)).json()).messages).toHaveLength(0)
  await page.reload()
  await page.getByRole('button', { name: '助手面板', exact: true }).click()
  await expect(approval).toContainText('已拒绝')
  await a.dispose()
})
