import type { Page } from '@playwright/test'

export async function setVisualTime(page: Page): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-10-17T00:00:00.000Z'))
}
