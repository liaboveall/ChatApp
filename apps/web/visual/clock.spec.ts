import { expect, test } from '@playwright/test'
import { setVisualTime } from './clock.ts'

const cases = [
  {
    browserTime: '2026-10-03T00:00:00.000Z',
    firstStatus: '有效',
    secondStatus: '已用完',
  },
  {
    browserTime: '2040-01-01T00:00:00.000Z',
    firstStatus: '已过期',
    secondStatus: '已过期',
  },
] as const

for (const theme of ['light', 'dark'] as const) {
  for (const { browserTime, firstStatus, secondStatus } of cases) {
    test(`invitation snapshots stay fixed from ${browserTime} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1000, height: 720 })
      await page.clock.setFixedTime(new Date(browserTime))
      await page.goto(
        `/iframe.html?id=pages-settings--invitations&viewMode=story&globals=theme:${theme}`,
      )
      await expect(page.getByText(new RegExp(`^${firstStatus} · 2026年10月9日`))).toBeVisible()
      await expect(page.getByText(new RegExp(`^${secondStatus} · 2026年10月20日`))).toBeVisible()

      await setVisualTime(page)
      await page.reload()
      await expect(page.getByText(/^已过期 · 2026年10月9日/)).toBeVisible()
      await expect(page.getByText(/^已用完 · 2026年10月20日/)).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      await expect(page).toHaveScreenshot(`pages-settings--invitations--${theme}.png`)
    })
  }
}
