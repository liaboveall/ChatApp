import type { Locator, Page } from '@playwright/test'
import { expect } from './fixtures.ts'

/**
 * The first read of the notification centre, which the shell makes a moment after it is ready (M6). A sign-in waits for it:
 * a test that ends the session, cuts the network or holds an answer right after signing in would otherwise be raced by that
 * read (it would be the request that finds out first). Call it before the step that signs in.
 */
export function firstNoticesRead(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/notifications',
  )
}

/** Signs in through the sign-in form and waits for the app shell, and for the shell's own first reads. */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  const notices = firstNoticesRead(page)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  // The sidebar is a hidden drawer on narrow windows; the welcome heading is in the main area at every width.
  await expect(page.getByRole('heading', { name: /^欢迎回来/ })).toBeVisible()
  await notices
}

/**
 * Chooses the theme the way a member does, before the page loads. The theme is the light one unless a member chooses
 * otherwise (appearance.ts), whatever the system prefers, so emulating the system's scheme alone would show the light
 * theme in both passes of a test that means to look at both.
 */
export async function chooseTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem('chatapp.appearance', JSON.stringify({ theme: value }))
  }, theme)
}

export async function openSettings(
  page: Page,
  section: 'appearance' | 'account' | 'invites' | 'assistant' | 'notifications',
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

/**
 * Waits until nothing on the page is on its way any more: every animation and transition that ends has ended. A check of
 * what the page looks like at rest (the contrast of its text, for one) must not be made while a pane is still fading in:
 * the text of a half-transparent pane has half its contrast for that moment, and that is not what the check is about.
 *
 * Left alone, because they never end on their own: the ones that run for ever (the lights of the wallpaper, the dots of
 * "typing") and the ones that follow a scroll position instead of the clock (the fading ends of the narrow settings'
 * row of sections). And the wait itself gives up after two seconds: nothing here takes that long, and a check that
 * follows should say what it finds rather than time out in its preparation.
 */
export async function pageAtRest(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const deadline = performance.now() + 2000
    for (;;) {
      const moving = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === 'running' &&
            animation.timeline === document.timeline &&
            animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY,
        )
      const left = deadline - performance.now()
      if (moving.length === 0 || left <= 0) return
      await Promise.race([
        Promise.all(moving.map((animation) => animation.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, left)),
      ])
    }
  })
}
