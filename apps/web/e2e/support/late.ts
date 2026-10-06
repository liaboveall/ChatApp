/**
 * Helpers for the tests of answers that come back late (D-171, D-173, D-174): a request is made, the server handles it, and
 * the answer is held back until the test lets the page have it, usually after the person in front of the screen has changed.
 * The held answer is delivered, and the page is given its turn to act on it, before anything is asserted: the assertion is
 * about what the page does with a late answer.
 */
import type { Page, Response } from '@playwright/test'
import { expect } from './fixtures.ts'

/**
 * Holds the answer to the first matching request until `deliver()`. The server has handled the request by then (its effect
 * is real and stays), the page has not been told yet. `deliver` gives the page the answer and then a few frames to act on it.
 * `matching` tells requests to the same address apart by what they carry (the page may make more than one).
 */
export async function holdAnswer<T = { message: { id: string; seq: number } }>(
  page: Page,
  url: RegExp,
  method: string,
  matching?: (body: string | null) => boolean,
) {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reached: (body: T) => void = () => undefined
  const answered = new Promise<T>((resolve) => {
    reached = resolve
  })
  let fulfilled: () => void = () => undefined
  const given = new Promise<void>((resolve) => {
    fulfilled = resolve
  })
  let taken = false
  await page.route(url, async (route) => {
    if (taken || route.request().method() !== method) return route.continue()
    if (matching !== undefined && !matching(route.request().postData())) return route.continue()
    taken = true
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    reached((await response.json()) as T)
    await gate
    await route.fulfill({ response })
    fulfilled()
  })
  return {
    /** The server has handled it; what the answer says. */
    reached: answered,
    async deliver(): Promise<void> {
      release()
      await given
      // The page reads the body and acts on it in the turns after the answer arrives: let two frames pass.
      await frames(page)
    },
  }
}

/** Two animation frames: what the page does with an answer it was just given (reading the body, merging, rendering) is done. */
export const frames = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )

/** Resolves once the page has received, in its catch-up reads of the conversation, a version of every one of these messages. */
export function waitForChanges(
  page: Page,
  conversationId: string,
  messageIds: string[],
): Promise<void> {
  const missing = new Set(messageIds)
  return new Promise((resolve) => {
    const listener = async (response: Response): Promise<void> => {
      if (!response.url().includes(`/api/conversations/${conversationId}/changes`)) return
      const body = await response.text().catch(() => '')
      for (const messageId of [...missing]) if (body.includes(messageId)) missing.delete(messageId)
      if (missing.size > 0) return
      page.off('response', listener)
      resolve()
    }
    page.on('response', listener)
  })
}

/**
 * Records whether a text is in the elements matching `css` at any moment from now on (a mutation observer, not a poll, so
 * that a text that is there for a single frame is seen); the returned function says whether it ever was.
 */
export async function watchText(
  page: Page,
  css: string,
  needle: string,
): Promise<() => Promise<boolean>> {
  const key = `__seen:${css}:${needle}`
  await page.evaluate(
    ([selector, text, flag]) => {
      const holder = window as unknown as Record<string, boolean>
      const look = (): boolean =>
        [...document.querySelectorAll(selector as string)].some((element) =>
          (element.textContent ?? '').includes(text as string),
        )
      holder[flag as string] = look()
      new MutationObserver(() => {
        if (look()) holder[flag as string] = true
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    },
    [css, needle, key],
  )
  return () =>
    page.evaluate((flag) => (window as unknown as Record<string, boolean>)[flag] === true, key)
}

/**
 * Signs out through the settings panel without leaving the page: a held request stays alive only in the same document.
 * Whatever has the focus (a field, a button) is let go of first, so that the shortcut for the settings is not taken as typing.
 */
export async function signOutInPlace(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Control+,')
  await page
    .getByRole('dialog', { name: '设置' })
    .getByRole('link', { name: '账号', exact: true })
    .click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login/)
}

export async function signInInPlace(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^欢迎回来/ })).toBeVisible()
}
