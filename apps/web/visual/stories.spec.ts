import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

type IndexEntry = { id: string; type: string; tags?: string[] }

/** The stories to photograph: those tagged `visual` in the built Storybook's index. */
const index = JSON.parse(readFileSync('storybook-static/index.json', 'utf8')) as {
  entries: Record<string, IndexEntry>
}
const stories = Object.values(index.entries).filter(
  (entry) => entry.type === 'story' && entry.tags?.includes('visual'),
)

/** Shell stories are wide; everything else fits a smaller frame. */
const size = (id: string) => {
  if (id.startsWith('layout-app-shell')) return { width: 1440, height: 760 }
  // The registration page is the tallest page; give the authentication pages room to be photographed whole.
  if (id.startsWith('pages-authentication')) return { width: 1000, height: 1000 }
  // The panels of the Inspector are tall (members, links, bans, settings, the danger zone): photographed whole.
  if (/^inspector-details--(owner|plain-member|site-administrator|direct-message)/.test(id)) {
    return { width: 1000, height: 1528 }
  }
  return { width: 1000, height: 720 }
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(theme, () => {
    for (const story of stories) {
      test(story.id, async ({ page }) => {
        await page.setViewportSize(size(story.id))
        await page.goto(`/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`)
        await page
          .locator(
            '#storybook-root > *, body > [data-base-ui-portal], body > [role="presentation"]',
          )
          .first()
          .waitFor()
        await page.evaluate(() => document.fonts.ready)
        // Let layout, glass and Base UI's positioning settle before the picture is taken.
        await page.waitForTimeout(400)
        await expect(page).toHaveScreenshot(`${story.id}--${theme}.png`)
      })
    }
  })
}
