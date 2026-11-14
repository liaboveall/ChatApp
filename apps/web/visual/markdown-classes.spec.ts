import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { setVisualTime } from './clock.ts'

/**
 * A message looks the same whatever the Markdown library's own class names do.
 *
 * The library writes Tailwind class names on what it renders. The application styles its output itself and does not
 * mean those names to do anything, but Tailwind builds every class it finds named anywhere in this package, so which
 * of them exist is an accident of what other files happen to say. Three accidents have been seen (2026-11-12 and
 * 2026-11-14): a word in a comment gave every piece of fenced code, its body and its copy button a frame of their own;
 * the lines of code only stood one under the other because another file named the class that makes them lines; and a
 * quotation was slanted although the stylesheet says it is not, because a name the library gives it was built.
 *
 * Both directions are checked against the pictures of two stories that hold every kind of Markdown a message can
 * have: with every one of the library's names turned into the rule Tailwind would build for it, and with the names
 * taken off altogether.
 *
 * The rules are in library-utilities.css and not in this file, and nothing here spells one of the names as a word of
 * its own: Tailwind reads this file too.
 */

const UTILITIES = readFileSync('visual/library-utilities.css', 'utf8')
const FENCE = '[data-streamdown="code-block"]'
const STORIES = ['timeline-rows--conversation', 'timeline-rows--long-and-mixed']

async function openStory(page: Page, story: string, theme: string): Promise<void> {
  await page.setViewportSize({ width: 1000, height: 720 })
  await setVisualTime(page)
  await page.goto(`/iframe.html?id=${story}&viewMode=story&globals=theme:${theme}`)
  await page.locator('#storybook-root > *').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  if (story === 'timeline-rows--conversation') {
    await expect(page.locator(FENCE).getByText('const', { exact: true })).toBeVisible()
  }
}

for (const story of STORIES) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${story} is the same with every class name of the library built, ${theme}`, async ({
      page,
    }) => {
      await openStory(page, story, theme)
      await page.addStyleTag({ content: UTILITIES })
      // The fixture really is in force: its marker rule applies to an element of that class.
      const probe = await page.evaluate(() => {
        const element = document.createElement('div')
        element.className = 'library-utilities-fixture'
        document.body.append(element)
        const padding = getComputedStyle(element).paddingTop
        element.remove()
        return padding
      })
      expect(probe).toBe('7px')
      await page.waitForTimeout(400)
      await expect(page).toHaveScreenshot(`${story}--${theme}.png`)
    })

    test(`${story} is the same with the library's class names taken off, ${theme}`, async ({
      page,
    }) => {
      await openStory(page, story, theme)
      // What the library rendered: its wrapper, every element it marks, and everything inside fenced code. Elements of
      // the application's own in a message (a mention, a link) keep their classes.
      const stripped = await page.evaluate((fence) => {
        const own = new Set<Element>()
        for (const element of document.querySelectorAll(
          `.md > div, .md [data-streamdown], ${fence} *`,
        )) {
          own.add(element)
        }
        let count = 0
        for (const element of own) {
          if (element.hasAttribute('class')) {
            element.removeAttribute('class')
            count++
          }
        }
        return count
      }, FENCE)
      expect(stripped).toBeGreaterThan(3)
      await page.waitForTimeout(400)
      await expect(page).toHaveScreenshot(`${story}--${theme}.png`)
    })
  }
}
