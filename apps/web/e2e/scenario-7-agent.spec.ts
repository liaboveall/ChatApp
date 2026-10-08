import { createVerifiedMember } from './support/api.ts'
import {
  composer,
  createGroupApi,
  myId,
  openFromSidebar,
  sendApi,
  sendFromComposer,
  signedIn,
} from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { openSettings, signIn } from './support/ui.ts'

test('M4 scenario 7: private assistant, tools, regeneration, usage, rename and delete', async ({
  page,
}) => {
  const alice = await createVerifiedMember('agent')
  await signIn(page, alice.email, alice.password)
  await page.keyboard.press('Control+k')
  await page.getByRole('option', { name: '新建助手对话' }).click()
  const dialog = page.getByRole('dialog', { name: '新建助手对话' })
  await dialog.getByRole('textbox', { name: '告诉助手你需要什么' }).fill('请总结可见消息')
  await dialog.getByRole('button', { name: '询问助手' }).click()
  await expect(page).toHaveURL(/\/c\//)
  await expect(
    page.locator('.agent-run-card').getByRole('button', { name: '重新生成' }),
  ).toBeVisible()
  const first = await page.locator('[data-message-id]').last().getAttribute('data-message-id')
  await page.getByText('查看工具步骤', { exact: true }).click()
  await expect(page.locator('.agent-run-card')).toContainText('read_conversation')
  await page.locator('.agent-run-card').getByRole('button', { name: '重新生成' }).click()
  await expect(
    page.locator('.agent-run-card').getByRole('button', { name: '重新生成' }),
  ).toBeVisible()
  expect(await page.locator('[data-message-id]').last().getAttribute('data-message-id')).toBe(first)
  await page.getByRole('button', { name: '重命名助手对话' }).click()
  await page.getByRole('textbox', { name: '重命名助手对话' }).fill('我的助手测试')
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.toolbar__title')).toHaveText('我的助手测试')
  await openSettings(page, 'account')
  await expect(page.getByRole('region', { name: 'AI 用量' })).toContainText(
    /今日已用 \d+ \/ 500000/,
  )
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await openFromSidebar(page, '我的助手测试')
  await page.getByRole('button', { name: '删除助手对话' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除助手对话', exact: true }).click()
  await expect(page).not.toHaveURL(/\/c\//)
  await expect(page.locator('.sidebar__scroll')).not.toContainText('我的助手测试')
})

test('M4: current panel remains private, drafts require insertion, slash commands and keyword search work', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('panel')
  const bob = await createVerifiedMember('peer')
  const a = await signedIn(alice)
  const b = await signedIn(bob)
  const name = `助手面板${Date.now().toString(36)}`
  const id = await createGroupApi(a, name, [await myId(b)])
  await sendApi(a, id, '上线安排：周五下午发布，由李明负责。')
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  const other = await newContext(browser)
  const peer = await other.newPage()
  await signIn(peer, bob.email, bob.password)
  await openFromSidebar(peer, name)
  await page.getByRole('button', { name: '助手面板', exact: true }).click()
  const panel = page.locator('.agent-panel')
  await panel.getByRole('button', { name: '起草回复', exact: true }).click()
  await expect(panel.getByRole('button', { name: '插入输入框' }).last()).toBeVisible()
  await expect(composer(page)).toHaveValue('')
  await panel.getByRole('button', { name: '插入输入框' }).last().click()
  await expect(page.getByRole('region', { name: '预览消息' })).toContainText('已读取可见消息')
  await expect(page.locator('.composer__preview [data-streamdown="strong"]')).toHaveText('讨论摘要')
  await expect(page.locator('.composer__preview')).not.toContainText(/seq\s*\d|<@user:/)
  await page.getByRole('button', { name: '编辑内容', exact: true }).click()
  await expect(composer(page)).not.toHaveValue('')
  await expect(peer.locator('.convo')).not.toContainText('已读取可见消息')
  await composer(page).fill('/translate')
  await sendFromComposer(page, '/translate')
  await expect(panel.locator('.agent-panel__message')).toHaveCount(4)
  await page.getByRole('button', { name: '关闭面板' }).click()
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('上线安排')
  const sourceOption = page.getByRole('option', { name: /^上线安排：周五下午发布/ })
  await expect(sourceOption).toBeVisible()
  await sourceOption.click()
  await expect(page.locator('.msg--flash')).toContainText('上线安排')
  await a.dispose()
  await b.dispose()
})

test('M4 trial fixes: panel sessions can be created, restored, renamed and deleted without affecting the group', async ({
  page,
}) => {
  const alice = await createVerifiedMember('history')
  const bob = await createVerifiedMember('private')
  const a = await signedIn(alice)
  const b = await signedIn(bob)
  const name = `助手历史${Date.now().toString(36)}`
  const id = await createGroupApi(a, name, [await myId(b)])
  await sendApi(a, id, '集合时间：周六早上八点。')
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await page.getByRole('button', { name: '助手面板', exact: true }).click()
  const panel = page.locator('.agent-panel')
  const history = panel.getByRole('combobox', { name: '对话历史' })
  const prompt = panel.getByRole('textbox', { name: '告诉助手你需要什么' })
  await prompt.fill('第一段私有讨论')
  await panel.getByRole('button', { name: '询问助手' }).click()
  await expect(panel.getByRole('button', { name: '插入输入框' })).toBeVisible()
  const first = await history.inputValue()
  expect(first).not.toBe('')
  expect((await b.get(`/api/conversations/${first}`)).status()).toBe(404)
  await panel.getByRole('button', { name: '新建助手对话' }).click()
  await expect(history).toHaveValue('')
  await expect(panel.locator('.agent-panel__message')).toHaveCount(0)
  await expect(history.locator('option')).toHaveCount(2)
  await prompt.fill('第二段私有讨论')
  await panel.getByRole('button', { name: '询问助手' }).click()
  await expect(panel.getByRole('button', { name: '插入输入框' })).toBeVisible()
  const second = await history.inputValue()
  expect(second).not.toBe(first)
  await expect(panel.locator('.agent-panel__messages')).not.toContainText('第一段私有讨论')
  await history.selectOption(first)
  await expect(panel.locator('.agent-panel__messages')).toContainText('第一段私有讨论')
  await expect(panel.locator('.agent-panel__messages')).not.toContainText('第二段私有讨论')
  await prompt.fill('第一段未发送草稿')
  await history.selectOption(second)
  await expect(prompt).toHaveValue('')
  await history.selectOption(first)
  await expect(prompt).toHaveValue('第一段未发送草稿')
  await panel.getByRole('button', { name: '总结未读', exact: true }).click()
  await expect(panel.locator('.agent-panel__message')).toHaveCount(4)
  await expect(prompt).toHaveValue('第一段未发送草稿')
  await panel.getByRole('radio', { name: '所有可访问会话', exact: true }).click()
  const commandResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/agent/runs') && response.request().method() === 'POST',
  )
  await sendFromComposer(page, '/translate')
  const command = await (await commandResponse).json()
  expect(command.run.conversationId).toBe(first)
  expect(command.run.readScope).toBe('all_accessible')
  await expect(panel.locator('.agent-panel__message')).toHaveCount(6)
  await expect(prompt).toHaveValue('第一段未发送草稿')
  await history.selectOption(second)
  await expect(panel.locator('.agent-panel__message')).toHaveCount(2)
  await history.selectOption(first)
  await panel.getByRole('button', { name: '重命名助手对话' }).click()
  await page.getByRole('textbox', { name: '重命名助手对话' }).fill('行程整理')
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
  await expect(history.locator('option:checked')).toHaveText('行程整理')
  await panel.getByRole('button', { name: '删除助手对话' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '删除助手对话', exact: true }).click()
  await expect(page).toHaveURL(`/c/${id}`)
  await expect(history).toHaveValue('')
  await expect(history.locator('option')).toHaveCount(2)
  await expect(history).not.toContainText('行程整理')
  await history.selectOption(second)
  await expect(panel.locator('.agent-panel__messages')).toContainText('第二段私有讨论')
  await expect(page.locator('.timeline')).not.toContainText('私有讨论')
  await page.reload()
  await page.getByRole('button', { name: '助手面板', exact: true }).click()
  await expect(history).toHaveValue(second)
  await expect(panel.locator('.agent-panel__messages')).toContainText('第二段私有讨论')
  const restoredResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/agent/runs') && response.request().method() === 'POST',
  )
  await sendFromComposer(page, '/draft')
  expect((await (await restoredResponse).json()).run.conversationId).toBe(second)
  await a.dispose()
  await b.dispose()
})

test('M4 trial fixes: English controls fit the inspector and the disclosure has its own space', async ({
  page,
}, info) => {
  const alice = await createVerifiedMember('english')
  const a = await signedIn(alice)
  const name = `English panel ${Date.now().toString(36)}`
  const id = await createGroupApi(a, name)
  for (let i = 0; i < 8; i++)
    await sendApi(a, id, `消息 ${i}：周六早上八点集合。\n请提前准备好饮水。\n地点是地铁站出口。`)
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await openSettings(page, 'appearance')
  await page.getByRole('radio', { name: 'English' }).click()
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.goto(`/c/${id}`)
  await expect(page.locator('.toolbar__title')).toHaveText(name)
  await page.getByRole('button', { name: 'Assistant panel', exact: true }).click()
  const panel = page.locator('.agent-panel')
  await expect(
    panel.getByRole('radio', { name: 'All accessible conversations', exact: true }),
  ).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Draft reply', exact: true })).toBeVisible()
  for (const width of [1440, 1100, 800]) {
    await page.setViewportSize({ width, height: 950 })
    await expect
      .poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1)
    const limits = await page.locator('.convo').evaluate((element) => {
      const timeline = element.querySelector('.timeline')?.getBoundingClientRect()
      const dock = element.querySelector('.composer-dock')?.getBoundingClientRect()
      return { bottom: timeline?.bottom ?? Infinity, top: dock?.top ?? -Infinity }
    })
    expect(limits.bottom).toBeLessThanOrEqual(limits.top)
  }
  await panel.getByRole('button', { name: 'Draft reply', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Insert into composer' })).toBeVisible()
  await panel.getByRole('button', { name: 'Insert into composer' }).click()
  await expect(page.getByRole('region', { name: 'Preview message' })).toBeVisible()
  await expect
    .poll(() => panel.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeLessThanOrEqual(1)
  await page.setViewportSize({ width: 1440, height: 950 })
  await expect(panel.getByRole('button', { name: 'Ask assistant', exact: true })).toBeInViewport()
  await page.screenshot({
    path: `../../.test-runs/trial-fixes/english-panel-${info.project.name}.png`,
  })
  await a.dispose()
})

test('M4: a shared @Agent reply reaches current members; tool details remain caller-only', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('mention')
  const bob = await createVerifiedMember('reader')
  const a = await signedIn(alice)
  const b = await signedIn(bob)
  const name = `共享助手${Date.now().toString(36)}`
  const id = await createGroupApi(a, name, [await myId(b)])
  const citationId = '00000000-0000-4000-8000-000000000009'
  const sourceBody = `王华周五部署 — 即\`${citationId}\`。\n\n|事项|内容|来源消息（发送者 / 时间 UTC / 消息ID）|\n|---|---|---|\n|预算|2433元|王华，05-04 01:34 UTC，\`${citationId}\`|`
  // Keep the whole citation in the normal fast-mode preview, so truncation cannot hide this regression.
  expect(Array.from(sourceBody).length).toBeLessThanOrEqual(200)
  await sendApi(a, id, sourceBody)
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  const other = await newContext(browser)
  const peer = await other.newPage()
  await signIn(peer, bob.email, bob.password)
  await openFromSidebar(peer, name)
  await composer(page).fill('@助')
  await page.getByRole('option').filter({ hasText: '助手' }).click()
  const token = await composer(page).inputValue()
  expect(token).toBe('@助手 ')
  await sendFromComposer(page, `${token} 总结部署安排`)
  const sharedReply = peer.getByRole('article').filter({ hasText: '已读取可见消息' })
  await expect(sharedReply).toBeVisible()
  await expect(sharedReply).not.toContainText(/\bseq\s*\d+|<@user:|messageId/iu)
  await expect(
    page.locator('.agent-run-card').getByRole('button', { name: '重新生成' }),
  ).toBeVisible()
  await expect(sharedReply).toContainText('王华')
  await expect(sharedReply).toContainText('2433元')
  await expect(sharedReply).toContainText('01:34 UTC')
  await expect(sharedReply).not.toContainText(citationId)
  await expect(sharedReply).not.toContainText('查看工具步骤')
  const sidebarPreview = peer.locator(`[data-conversation-id="${id}"]`).locator('.s-item__preview')
  await expect(sidebarPreview).toContainText('讨论摘要')
  await expect(sidebarPreview).not.toContainText('**')
  await peer.reload()
  await expect(sharedReply).toContainText('王华')
  await expect(sharedReply).toContainText('2433元')
  await expect(sharedReply).toContainText('01:34 UTC')
  await expect(sharedReply).not.toContainText(citationId)
  await expect(sidebarPreview).toContainText('讨论摘要')
  await expect(sidebarPreview).not.toContainText('**')
  await a.dispose()
  await b.dispose()
})

test('M4 trial fixes: sidebar Markdown previews stay readable after sending and reloading', async ({
  page,
}) => {
  const alice = await createVerifiedMember('preview')
  const a = await signedIn(alice)
  const name = `侧栏预览${Date.now().toString(36)}`
  const id = await createGroupApi(a, name)
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  const body = '**当前会话总结**\n\n- **时间**：八点\n- [路线图](https://example.com/map)'
  await sendFromComposer(page, body)
  const preview = page.locator(`[data-conversation-id="${id}"]`).locator('.s-item__preview')
  await expect(preview).toHaveText('你：当前会话总结 时间：八点 路线图')
  await expect(page.locator('article[data-message-id] .md [data-streamdown="strong"]')).toHaveText([
    '当前会话总结',
    '时间',
  ])
  await page.reload()
  await expect(preview).toHaveText('你：当前会话总结 时间：八点 路线图')
  await a.dispose()
})
