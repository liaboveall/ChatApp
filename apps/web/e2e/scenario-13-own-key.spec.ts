import type { Page } from '@playwright/test'
import { createVerifiedMember } from './support/api.ts'
import { composer, sendFromComposer } from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import { openSettings, signIn } from './support/ui.ts'

async function saveKey(page: Page, key: string) {
  await openSettings(page, 'assistant')
  await page.getByRole('textbox', { name: 'DeepSeek API key' }).fill(key)
  await page.getByRole('button', { name: '验证并保存', exact: true }).click()
  await expect(page.getByText(`末 4 位 ${key.slice(-4)}`, { exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'DeepSeek API key' })).toHaveValue('')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
}
async function newChat(page: Page, prompt: string) {
  await page.keyboard.press('Control+k')
  await page.getByRole('option', { name: '新建助手对话' }).click()
  const dialog = page.getByRole('dialog', { name: '新建助手对话' })
  await dialog.getByRole('textbox', { name: '告诉助手你需要什么' }).fill(prompt)
  const answer = page.waitForResponse(
    (r) => r.url().endsWith('/api/agent/runs') && r.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: '询问助手' }).click()
  return (await (await answer).json()).run
}
test('M5 scenario 13: an own key uses its own accounting; switching to the site creates a blank segment', async ({
  page,
}) => {
  const alice = await createVerifiedMember('ownkey')
  await signIn(page, alice.email, alice.password)
  await saveKey(page, 'sk-mock-e2e-member-only-8319')
  const run = await newChat(page, '私有偏好 CANARY_OWN_PROMPT：不要带到站点助手。')
  expect(run.keySource).toBe('user')
  expect(run.privacyClass).toBe('byok_private')
  await expect(
    page.locator('.agent-run-card').getByRole('button', { name: '重新生成' }),
  ).toBeVisible()
  await openSettings(page, 'assistant')
  const usage = page.getByRole('region', { name: 'AI 用量' })
  await expect(usage).toContainText('今日已用 0 / 500000')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.goto(`/c/${run.conversationId}`)
  await composer(page).fill('CANARY_UNSENT_PRIVATE_DRAFT')
  await page.getByRole('button', { name: '改用站点额度', exact: true }).click()
  await expect(
    page.getByText('已开启新的对话段，之前的上下文不会带入。', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.timeline')).not.toContainText('CANARY_OWN_PROMPT')
  await expect(composer(page)).toHaveValue('')
  await expect(page.locator('.agent-key-source')).toContainText('使用站点额度')
  await page.reload()
  await expect(page.locator('.timeline')).not.toContainText('CANARY_OWN_PROMPT')
  const answer = page.waitForResponse(
    (r) => r.url().endsWith('/api/agent/runs') && r.request().method() === 'POST',
  )
  await sendFromComposer(page, '请总结当前可见消息')
  const site = (await (await answer).json()).run
  expect(site.keySource).toBe('site')
  expect(site.privacyClass).toBe('standard')
  await expect(
    page.locator('.agent-run-card').getByRole('button', { name: '重新生成' }),
  ).toBeVisible()
  await expect(page.locator('.timeline')).not.toContainText('CANARY_OWN_PROMPT')
})
test('M5 scenario 13: a key refused at execution offers a site request with an empty prompt', async ({
  page,
}) => {
  const alice = await createVerifiedMember('revoked')
  await signIn(page, alice.email, alice.password)
  await saveKey(page, 'sk-mock-revoked-e2e-4791')
  const run = await newChat(page, '私有故障请求 CANARY_FAILED_PROMPT')
  const switchButton = page.getByRole('button', { name: '使用站点额度发起新请求', exact: true })
  await expect(switchButton).toBeVisible()
  await composer(page).fill('CANARY_FAILED_UNSENT_DRAFT')
  await switchButton.click()
  await expect(composer(page)).toHaveValue('')
  await expect(page.locator('.timeline')).not.toContainText('CANARY_FAILED_PROMPT')
  expect(run.keySource).toBe('user')
})

for (const verdict of [
  {
    key: 'sk-mock-invalid-e2e-0000',
    code: 'AI_KEY_INVALID',
    reason: 'invalid',
    message: '这个 key 没有通过验证。',
  },
  {
    key: 'sk-mock-broke-e2e-0000',
    code: 'AI_KEY_INVALID',
    reason: 'insufficient_balance',
    message: '这个 key 的余额不足。',
  },
  {
    key: 'sk-mock-limited-e2e-0000',
    code: 'RATE_LIMITED',
    reason: undefined,
    message: '操作太频繁了，请 30 秒后再试。',
  },
] as const) {
  test(`M5 V-17 mock contract: ${verdict.reason ?? verdict.code} is distinct and never stores a key`, async ({
    page,
  }) => {
    const alice = await createVerifiedMember('keyverdict')
    await signIn(page, alice.email, alice.password)
    await openSettings(page, 'assistant')
    const field = page.getByRole('textbox', { name: 'DeepSeek API key' })
    await field.fill(verdict.key)
    const answer = page.waitForResponse(
      (r) => r.url().endsWith('/api/me/ai-key') && r.request().method() === 'PUT',
    )
    await page.getByRole('button', { name: '验证并保存', exact: true }).click()
    const response = await answer
    const body = await response.json()
    expect(body.error.code).toBe(verdict.code)
    if (verdict.reason) expect(body.error.details.reason).toBe(verdict.reason)
    else expect(response.headers()['retry-after']).toBe('30')
    await expect(page.getByText(verdict.message, { exact: true })).toBeVisible()
    await expect(field).toHaveValue(verdict.key)
    expect(
      await page.evaluate(async () => (await (await fetch('/api/me/ai-key')).json()).aiKey),
    ).toBeNull()
  })
}
