import { expect, test } from '@playwright/test'
import { setVisualTime } from './clock.ts'

for (const theme of ['light', 'dark'] as const) {
  test(`timeline waits for the TypeScript grammar before rendering in ${theme}`, async ({
    page,
  }) => {
    let release!: () => void
    let requested!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      requested = resolve
    })
    await page.route(/\/assets\/typescript-[^/]+\.js$/, async (route) => {
      requested()
      await held
      await route.continue()
    })
    try {
      await page.setViewportSize({ width: 1000, height: 720 })
      await setVisualTime(page)
      await page.goto(
        `/iframe.html?id=timeline-rows--conversation&viewMode=story&globals=theme:${theme}`,
        { waitUntil: 'domcontentloaded' },
      )
      await started
      // Give the browser a paint while the grammar is held: the story must never expose the plain-code fallback.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          }),
      )
      await expect(page.locator('#storybook-root')).not.toContainText('const total')
      release()
      await expect(
        page.locator('[data-streamdown="code-block"]').getByText('const', { exact: true }),
      ).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      await expect(page).toHaveScreenshot(`timeline-rows--conversation--${theme}.png`)
    } finally {
      release()
    }
  })
}
