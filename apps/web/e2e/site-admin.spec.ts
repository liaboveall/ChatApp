import AxeBuilder from '@axe-core/playwright'
import { clientSiteLimitsSchema, siteSettingsSchema } from '@chatapp/contracts'
import type { APIRequestContext, Page } from '@playwright/test'
import { adminCredentials } from './support/accounts.ts'
import { administratorApi, createVerifiedMember } from './support/api.ts'
import {
  createGroupApi,
  message,
  myId,
  openFromSidebar,
  sendApi,
  signedIn,
} from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { holdAnswer, signInInPlace, signOutInPlace, watchText } from './support/late.ts'
import { animationsFinished, signIn } from './support/ui.ts'

const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
let admin: APIRequestContext
test.beforeAll(async () => {
  admin = await administratorApi()
})
async function adminPage(page: Page, administrator = admin) {
  await page.context().addCookies((await administrator.storageState()).cookies)
  await page.goto('/admin')
  await expect(page.getByRole('heading', { name: '站点管理', exact: true })).toBeVisible()
  await expect(page.locator('.admin-row').first()).toBeVisible()
}
async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(tags).analyze()
  expect(
    result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target),
    })),
  ).toEqual([])
}
async function fits(page: Page, selector: string) {
  await animationsFinished(page.locator(selector))
  const size = await page
    .locator(selector)
    .evaluate((element) => ({ client: element.clientWidth, content: element.scrollWidth }))
  expect(size.content).toBeLessThanOrEqual(size.client)
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    root: document.documentElement.scrollWidth,
    nodes: ['html', 'body', '.window', '.app', '.dialog-host', '.dialog'].map((selector) => {
      const node = document.querySelector(selector)
      if (!node) return { selector }
      const style = getComputedStyle(node)
      const r = node.getBoundingClientRect()
      return {
        selector,
        width: r.width,
        left: r.left,
        client: node.clientWidth,
        scroll: node.scrollWidth,
        overflow: style.overflow,
        inline: node.getAttribute('style'),
      }
    }),
  }))
  if (layout.root > layout.viewport)
    await test.info().attach('layout-width.json', {
      body: JSON.stringify(layout),
      contentType: 'application/json',
    })
  expect(layout.root).toBeLessThanOrEqual(layout.viewport)
}
for (const scheme of ['light', 'dark'] as const) {
  test.describe(`M7 screens ${scheme}`, () => {
    test.use({ colorScheme: scheme })
    test('public privacy has accurate policy, both entrypoints and accessible narrow layouts', async ({
      page,
    }) => {
      await page.goto('/register')
      await page.getByRole('link', { name: '隐私与数据说明' }).click()
      await expect(page.getByRole('heading', { name: '隐私与数据说明', exact: true })).toBeVisible()
      await expect(page.locator('.privacy-page')).toContainText('30')
      for (const width of [320, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        await fits(page, '.privacy-page')
        await accessible(page)
      }
      const member = await createVerifiedMember(`privacy${scheme}`)
      await signIn(page, member.email, member.password)
      await page.goto('/?settings=account')
      await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
      await page.getByRole('link', { name: '隐私与数据说明' }).click()
      await expect(page.getByRole('heading', { name: '隐私与数据说明', exact: true })).toBeVisible()
    })
    test('administrator catalogs and settings remain accessible at small and desktop widths', async ({
      page,
    }) => {
      test.setTimeout(90_000)
      await adminPage(page)
      for (const width of [320, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        await fits(page, '.admin-page')
        await accessible(page)
      }
      for (const section of [
        '邀请',
        '频道与群组',
        '举报',
        '审计',
        'AI 用量',
        'AI 运行',
        '站点设置',
      ]) {
        await page
          .getByRole('navigation', { name: '站点管理' })
          .getByRole('button', { name: section, exact: true })
          .click()
        await expect(page.getByText('加载中', { exact: true })).toHaveCount(0)
        await accessible(page)
      }
      await expect(page.getByLabel('运行内容保留天数')).toHaveValue('30')
      await expect(page.getByLabel('暂停新的站点额度调用')).toBeVisible()
      for (const width of [320, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        await fits(page, '.admin-policy')
        await accessible(page)
      }
      const before = siteSettingsSchema.parse(await (await admin.get('/api/admin/settings')).json())
      try {
        await page.getByLabel('撤回时限（秒）').fill('121')
        await page.getByLabel('图片上限（MiB）').fill('19.5')
        const saved = page.waitForResponse(
          (response) =>
            response.url().endsWith('/api/admin/settings') &&
            response.request().method() === 'PATCH',
        )
        await page.getByRole('button', { name: '保存', exact: true }).click()
        expect((await saved).status()).toBe(200)
        await expect(page.getByLabel('图片上限（MiB）')).toHaveValue('19.5')
        const policy = clientSiteLimitsSchema.parse(
          await (await admin.get('/api/site-limits')).json(),
        )
        expect(policy.messageRecallWindowMs).toBe(121000)
        expect(policy.imageBytes).toBe(19.5 * 1024 * 1024)
        await page.reload()
        await page
          .getByRole('navigation', { name: '站点管理' })
          .getByRole('button', { name: '站点设置', exact: true })
          .click()
        await expect(page.getByLabel('撤回时限（秒）')).toHaveValue('121')
        await expect(page.getByLabel('图片上限（MiB）')).toHaveValue('19.5')
      } finally {
        const current = siteSettingsSchema.parse(
          await (await admin.get('/api/admin/settings')).json(),
        )
        const restored = await admin.patch('/api/admin/settings', {
          headers: { 'Idempotency-Key': crypto.randomUUID() },
          data: {
            expectedVersion: current.version,
            policy: before.policy,
            storageBudgetBytes: before.storageBudgetBytes,
          },
        })
        expect(restored.status()).toBe(200)
      }
    })
    test('a managed conversation can be archived and restored with a new name through versioned dialogs', async ({
      page,
    }) => {
      const owner = await createVerifiedMember(`lifecycle${scheme}`),
        ownerApi = await signedIn(owner)
      const name = `管理会话-${scheme}-${Date.now().toString(36)}`,
        newName = `恢复-${scheme}-${Date.now().toString(36)}`
      const id = await createGroupApi(ownerApi, name)
      await adminPage(page)
      await page
        .getByRole('navigation', { name: '站点管理' })
        .getByRole('button', { name: '频道与群组', exact: true })
        .click()
      async function search(value: string) {
        await page.getByLabel('搜索成员或会话').fill(value)
        await page.getByRole('button', { name: '搜索成员或会话', exact: true }).click()
      }
      await search(name)
      const row = page.locator('.admin-row').filter({ hasText: name })
      await expect(row).toBeVisible()
      await row.getByRole('button', { name: '归档', exact: true }).click()
      await page
        .getByRole('alertdialog', { name: '归档', exact: true })
        .getByRole('button', { name: '归档', exact: true })
        .click()
      await expect(row).toContainText('已归档')
      await row.getByRole('button', { name: '恢复', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '恢复', exact: true })
      await dialog.getByLabel('新名称（可选）').fill(newName)
      await accessible(page)
      await dialog.getByRole('button', { name: '恢复', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await search(newName)
      const restored = page.locator('.admin-row').filter({ hasText: newName })
      await expect(restored).toBeVisible()
      await expect(restored).not.toContainText('已归档')
      const response = await ownerApi.get(`/api/conversations/${id}`)
      expect(response.ok()).toBe(true)
      expect((await response.json()).name).toBe(newName)
      await ownerApi.dispose()
    })
    test('report disclosure, bounded audited context, decision and withdrawal reach the real server', async ({
      page,
      browser,
    }) => {
      test.setTimeout(120_000)
      const reporter = await createVerifiedMember(`report${scheme}`),
        author = await createVerifiedMember(`author${scheme}`)
      const r = await signedIn(reporter),
        a = await signedIn(author)
      const name = `举报流程-${scheme}-${Date.now().toString(36)}`
      const id = await createGroupApi(a, name, [await myId(r)])
      const body = `待举报的内容-${scheme}`,
        details = `补充情况-${scheme}`
      const target = await sendApi(a, id, body)
      await signIn(page, reporter.email, reporter.password)
      await openFromSidebar(page, name)
      await message(page, body).click({ button: 'right' })
      await page.getByRole('menuitem', { name: '举报消息' }).click()
      const dialog = page.getByRole('dialog', { name: '举报消息' })
      await expect(dialog).toContainText('前后各 5 条')
      await expect(page.locator('.menu')).toHaveCount(0)
      await dialog.getByLabel('补充说明').fill(details)
      await page.setViewportSize({ width: 320, height: 900 })
      await fits(page, '[role=dialog]')
      await accessible(page)
      await dialog.getByRole('button', { name: '提交举报' }).click()
      await expect(dialog).toHaveCount(0)
      const context = await newContext(browser),
        manager = await context.newPage()
      await adminPage(manager)
      await manager
        .getByRole('navigation', { name: '站点管理' })
        .getByRole('button', { name: '举报', exact: true })
        .click()
      const row = manager.locator('.admin-row').filter({ hasText: details })
      await expect(row).toBeVisible()
      await row.getByRole('button', { name: '查看举报上下文' }).click()
      await expect(manager.getByRole('dialog', { name: '查看举报上下文' })).toContainText(body)
      await accessible(manager)
      await manager.keyboard.press('Escape')
      await row.getByRole('button', { name: '标记已处理' }).click()
      const decision = manager.getByRole('dialog', { name: '标记已处理' })
      await decision.getByLabel('处理说明').fill('已核实并联系成员')
      await decision.getByRole('button', { name: '标记已处理', exact: true }).click()
      await expect(row).toContainText('已处理')
      expect((await a.post(`/api/messages/${target.id}/recall`, { data: {} })).ok()).toBe(true)
      await manager.getByRole('button', { name: '刷新', exact: true }).click()
      await expect(manager.locator('.admin-list')).not.toContainText(details)
      await manager
        .getByRole('navigation', { name: '站点管理' })
        .getByRole('button', { name: '审计', exact: true })
        .click()
      await expect(manager.locator('.admin-list')).toContainText('举报')
      await r.dispose()
      await a.dispose()
    })
  })
}
test('a late administrator context cannot appear after signing into another account', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const member = await createVerifiedMember('lateadmin'),
    outsider = await createVerifiedMember('nextadmin'),
    api = await signedIn(member)
  const id = await createGroupApi(api, `迟到的管理读取-${Date.now().toString(36)}`)
  const target = await sendApi(api, id, 'ADMIN_PRIVATE_CONTEXT_CANARY')
  const details = `late-read-canary-${crypto.randomUUID()}`
  expect(
    (
      await api.post('/api/reports', {
        data: { messageId: target.id, reason: 'other', details },
        headers: { 'idempotency-key': crypto.randomUUID() },
      })
    ).ok(),
  ).toBe(true)
  const isolatedAdmin = await signedIn({ ...adminCredentials(), name: 'administrator' })
  await adminPage(page, isolatedAdmin)
  await page
    .getByRole('navigation', { name: '站点管理' })
    .getByRole('button', { name: '举报', exact: true })
    .click()
  const row = page.locator('.admin-row').filter({ hasText: details })
  await expect(row).toBeVisible()
  const held = await holdAnswer<unknown>(page, /\/api\/admin\/reports\/[^/]+\/context$/, 'GET')
  await row.getByRole('button', { name: '查看举报上下文' }).click()
  await held.reached
  await signOutInPlace(page)
  const seen = await watchText(page, 'body', 'ADMIN_PRIVATE_CONTEXT_CANARY')
  await signInInPlace(page, outsider.email, outsider.password)
  await held.deliver()
  expect(await seen()).toBe(false)
  await expect(page.getByRole('dialog', { name: '查看举报上下文' })).toHaveCount(0)
  await page.goto('/admin')
  await expect(page).not.toHaveURL(/\/admin$/)
  await api.dispose()
  await isolatedAdmin.dispose()
})
