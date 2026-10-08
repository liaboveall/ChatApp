import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.ts'

/** Signs in through the sign-in form and waits for the app shell. */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  // The sidebar is a hidden drawer on narrow windows; the welcome heading is in the main area at every width.
  await expect(page.getByRole('heading', { name: /^欢迎回来/ })).toBeVisible()
}

export async function openSettings(
  page: Page,
  section: 'appearance' | 'account' | 'invites' | 'assistant',
): Promise<void> {
  await page.goto(`/?settings=${section}`)
  await expect(page.getByRole('dialog')).toBeVisible()
}

/**
 * Waits until the element's own animations (CSS animations and transitions) have finished. A rectangle measured while one
 * runs is the rectangle of a frame: the entrance of a floating panel is a transform, a browser works out the box of a
 * transformed element through a matrix, and the width can come out a binary fraction off (340.00006 instead of 340, seen
 * in WebKit, with Chromium doing the same within a frame or two). The test is about the layout, so it measures when the
 * frame is the last one, and keeps asking for the exact size.
 */
export async function animationsFinished(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    )
  })
}
