import { createVerifiedMember } from './support/api.ts'
import { expect, test } from './support/fixtures.ts'
import { openSettings, signIn } from './support/ui.ts'

test('M5 memories: private default, explicit site consent, versioned revocation, delete and persistence', async ({
  page,
}) => {
  const alice = await createVerifiedMember('memory')
  await signIn(page, alice.email, alice.password)
  await openSettings(page, 'assistant')
  const dialog = page.getByRole('dialog'),
    form = dialog.locator('.settings-memory-form')
  await form.getByRole('textbox', { name: '要记住的内容' }).fill('我开会时喜欢喝绿茶。')
  await expect(form.getByRole('switch', { name: '允许站点助手使用' })).not.toBeChecked()
  await form.getByRole('button', { name: '添加记忆', exact: true }).click()
  const row = dialog
    .locator('.row')
    .filter({ has: page.getByText('我开会时喜欢喝绿茶。', { exact: true }) })
  await expect(row).toContainText('仅私有助手可用')
  await row.getByRole('switch', { name: '允许站点助手使用' }).click()
  await expect(row).toContainText('站点助手也可使用')
  await row.getByRole('switch', { name: '允许站点助手使用' }).click()
  await expect(row).toContainText('仅私有助手可用')
  await page.reload()
  await expect(row).toContainText('仅私有助手可用')
  await row.getByRole('button', { name: '删除记忆', exact: true }).click()
  await expect(row).toHaveCount(0)
  await page.reload()
  await expect(dialog).toContainText('还没有保存记忆')
})
test('M5 memories: an explicit remember effect has an undo button and cannot be regenerated', async ({
  page,
}) => {
  const alice = await createVerifiedMember('remember')
  await signIn(page, alice.email, alice.password)
  await page.keyboard.press('Control+k')
  await page.getByRole('option', { name: '新建助手对话' }).click()
  const dialog = page.getByRole('dialog', { name: '新建助手对话' })
  await dialog
    .getByRole('textbox', { name: '告诉助手你需要什么' })
    .fill('记住：我喜欢在九点开始工作。')
  await dialog.getByRole('button', { name: '询问助手' }).click()
  const undo = page.getByRole('button', { name: '撤销这条记忆', exact: true })
  await expect(undo).toBeVisible()
  await expect(
    page.locator('.agent-run-card').getByRole('button', { name: '重新生成' }),
  ).toHaveCount(0)
  await undo.click()
  await expect(undo).toHaveCount(0)
  await openSettings(page, 'assistant')
  await expect(page.getByRole('dialog')).toContainText('还没有保存记忆')
})

for (const scheme of ['light', 'dark'] as const) {
  test(`M5 memories: visible consent and WCAG controls at 320 px in ${scheme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 })
    await page.emulateMedia({ colorScheme: scheme })
    const alice = await createVerifiedMember(`memory${scheme}`)
    await signIn(page, alice.email, alice.password)
    await openSettings(page, 'assistant')
    const dialog = page.getByRole('dialog'),
      form = dialog.locator('.settings-memory-form')
    await expect(form.getByText('允许站点助手使用', { exact: true })).toBeVisible()
    await expect(form.getByRole('switch', { name: '允许站点助手使用' })).not.toBeChecked()
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    const result = await new AxeBuilder({ page })
      .include('[role="dialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()
    expect(result.violations).toEqual([])
  })
}

import AxeBuilder from '@axe-core/playwright'
