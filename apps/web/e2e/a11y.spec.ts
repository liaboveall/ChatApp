import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { createVerifiedMember } from './support/api.ts'
import { expect, test } from './support/fixtures.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * Automated accessibility checks (docs/08 section 2, AT-21): axe-core against WCAG 2.2 A and AA on the key screens, in
 * light and dark. Axe finds a part of the problems (roughly a third); the keyboard, focus and reading-order checks in the
 * other specs and the by-hand screen-reader pass listed in docs/12 cover the rest.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

async function expectAccessible(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const found = result.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}\n` +
      violation.nodes
        .slice(0, 3)
        .map(
          (node) =>
            `    ${node.target.join(' ')}  ${node.failureSummary?.split('\n')[1]?.trim() ?? ''}`,
        )
        .join('\n'),
  )
  expect(found, `accessibility violations on ${label}`).toEqual([])
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe, ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    test('pages before sign-in', async ({ page }) => {
      for (const path of [
        '/login',
        '/register',
        '/forgot-password',
        '/check-email',
        '/verify-email#token=nonsense',
        '/reset-password',
      ]) {
        await page.goto(path)
        await expect(page.locator('main h1')).toBeVisible()
        await expectAccessible(page, `${path} (${scheme})`)
      }
    })

    test('the app shell, its dialogs and the settings sheet', async ({ page }) => {
      const person = await createVerifiedMember(`axe${scheme}`)
      await signIn(page, person.email, person.password)
      await expectAccessible(page, `shell (${scheme})`)

      await page.keyboard.press('Control+j')
      await expect(page.getByRole('complementary', { name: '详情与助手' })).toBeVisible()
      await expectAccessible(page, `shell with the assistant panel (${scheme})`)
      await page.keyboard.press('Control+j')

      await page.keyboard.press('Control+k')
      await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible()
      await expectAccessible(page, `command palette (${scheme})`)
      await page.keyboard.press('Escape')

      await page.keyboard.press('Control+/')
      await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toBeVisible()
      await expectAccessible(page, `shortcut help (${scheme})`)
      await page.keyboard.press('Escape')

      for (const section of ['appearance', 'account', 'invites'] as const) {
        await openSettings(page, section)
        await expectAccessible(page, `settings ${section} (${scheme})`)
      }
    })
  })
}
