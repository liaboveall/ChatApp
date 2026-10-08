import type { AgentContext } from '@chatapp/contracts'
import type { Page } from '@playwright/test'
import { createVerifiedMember } from './support/api.ts'
import { composer } from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import {
  holdAnswer,
  identityStatus,
  signInInPlace,
  signOutInPlace,
  watchText,
} from './support/late.ts'
import { openSettings, signIn } from './support/ui.ts'

async function assistantSettingsInPlace(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Control+,')
  await page
    .getByRole('dialog', { name: '设置' })
    .getByRole('link', { name: '助手', exact: true })
    .click()
}

test('M5 isolation: a late memory save cannot appear or clear the next accounts draft', async ({
  page,
}) => {
  const alice = await createVerifiedMember('m5latea')
  const bob = await createVerifiedMember('m5lateb')
  await signIn(page, alice.email, alice.password)
  await openSettings(page, 'assistant')
  const canary = 'M5_PRIVATE_MEMORY_FROM_PREVIOUS_ACCOUNT'
  const held = await holdAnswer<{ memory: { content: string } }>(
    page,
    /\/api\/me\/memories$/,
    'POST',
  )
  await page.getByRole('textbox', { name: '要记住的内容' }).fill(canary)
  await page.getByRole('button', { name: '添加记忆', exact: true }).click()
  expect((await held.reached).memory.content).toBe(canary)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await signOutInPlace(page)
  await signInInPlace(page, bob.email, bob.password)
  await assistantSettingsInPlace(page)
  const draft = page.getByRole('textbox', { name: '要记住的内容' })
  await draft.fill('M5_NEXT_ACCOUNT_UNSENT_MEMORY')
  const leaked = await watchText(page, 'body', canary)
  const success = await watchText(page, '.toast', '')
  await held.deliver()
  expect(await identityStatus(page)).toBe(200)
  expect(await leaked()).toBe(false)
  expect(await success()).toBe(false)
  await expect(draft).toHaveValue('M5_NEXT_ACCOUNT_UNSENT_MEMORY')
  await expect(page.getByRole('dialog')).toContainText('还没有保存记忆')
})

test('M5 isolation: a late key save cannot clear or replace the next accounts key form', async ({
  page,
}) => {
  const alice = await createVerifiedMember('m5keylatea')
  const bob = await createVerifiedMember('m5keylateb')
  await signIn(page, alice.email, alice.password)
  await openSettings(page, 'assistant')
  const held = await holdAnswer<{ aiKey: { last4: string } }>(page, /\/api\/me\/ai-key$/, 'PUT')
  await page
    .getByRole('textbox', { name: 'DeepSeek API key' })
    .fill('sk-mock-isolation-fixture-8842')
  await page.getByRole('button', { name: '验证并保存', exact: true }).click()
  expect((await held.reached).aiKey.last4).toBe('8842')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await signOutInPlace(page)
  await signInInPlace(page, bob.email, bob.password)
  await assistantSettingsInPlace(page)
  const field = page.getByRole('textbox', { name: 'DeepSeek API key' })
  await field.fill('sk-mock-next-account-unsent-7763')
  const leaked = await watchText(page, 'body', '末 4 位 8842')
  const success = await watchText(page, '.toast', '')
  await held.deliver()
  expect(await identityStatus(page)).toBe(200)
  expect(await leaked()).toBe(false)
  expect(await success()).toBe(false)
  await expect(field).toHaveValue('sk-mock-next-account-unsent-7763')
  await expect(page.getByText('末 4 位 8842', { exact: true })).toHaveCount(0)
})

test('M5 isolation: a stale context response cannot reopen the private segment after switching keys', async ({
  page,
}) => {
  const alice = await createVerifiedMember('m5contextlate')
  await signIn(page, alice.email, alice.password)
  await openSettings(page, 'assistant')
  await page.getByRole('textbox', { name: 'DeepSeek API key' }).fill('sk-mock-context-fixture-9921')
  await page.getByRole('button', { name: '验证并保存', exact: true }).click()
  await expect(page.getByText('末 4 位 9921', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.keyboard.press('Control+k')
  await page.getByRole('option', { name: '新建助手对话' }).click()
  const dialog = page.getByRole('dialog', { name: '新建助手对话' })
  const canary = 'M5_PRIVATE_SEGMENT_MUST_STAY_HIDDEN'
  await dialog.getByRole('textbox', { name: '告诉助手你需要什么' }).fill(canary)
  await dialog.getByRole('button', { name: '询问助手' }).click()
  await expect(page.locator('.agent-key-source')).toContainText('正在使用你的 API key')
  await expect(
    page.locator('.agent-run-card').getByRole('button', { name: '重新生成' }),
  ).toBeVisible()
  const held = await holdAnswer<AgentContext>(
    page,
    /\/api\/agent\/conversations\/[^/]+\/context$/,
    'GET',
  )
  expect((await held.reached).keySource).toBe('user')
  await composer(page).fill('M5_PRIVATE_UNSENT_SEGMENT_DRAFT')
  await page.getByRole('button', { name: '改用站点额度', exact: true }).click()
  await expect(page.locator('.agent-key-source')).toContainText('使用站点额度')
  await expect(page.locator('.timeline')).not.toContainText(canary)
  const leaked = await watchText(page, '.timeline', canary)
  await held.deliver()
  expect(await leaked()).toBe(false)
  await expect(page.locator('.agent-key-source')).toContainText('使用站点额度')
  await expect(page.locator('.timeline')).not.toContainText(canary)
  await expect(composer(page)).toHaveValue('')
})
