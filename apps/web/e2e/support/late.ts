/**
 * Helpers for the tests of answers that come back late (D-171, D-173, D-174, D-175): a request is made, the server handles
 * it, and the answer is held back until the test lets the page have it, usually after the person in front of the screen has
 * changed. The held answer is delivered, and the page is given its turn to act on it, before anything is asserted.
 *
 * When the session of the person who made the request has ended (a sign-out, a revocation), the page has given the request
 * up (D-175): the browser takes nothing of the held answer, so delivering it reaches nobody, and what is asserted is that
 * nothing of it got through to the next person, neither in the page nor in the cookies. When the session is the same (a
 * membership that ended and began again, a password changed), the answer is delivered to the page, and the guards of D-171
 * to D-174 are what the assertion is about.
 */
import type { APIResponse, Page, Response } from '@playwright/test'
import { expect } from './fixtures.ts'

/** The `Set-Cookie` lines of a response as the server wrote them: what the browser applies when the response reaches it. */
const setCookiesOf = (response: APIResponse): string[] =>
  response
    .headersArray()
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value)

/** Whether a `Set-Cookie` line tells the browser to drop a cookie. */
export const deletesCookie = (line: string): boolean =>
  /(^|;\s*)max-age=0(;|$)/i.test(line) || /^[^=]+=;/.test(line)

/**
 * Holds the answer to the first matching request until `deliver()`. The server has handled the request by then (its effect
 * is real and stays), the page has not been told yet. `deliver` gives the page the answer and then a few frames to act on it.
 * `matching` tells requests to the same address apart by what they carry (the page may make more than one).
 *
 * The answer is handed to the page as the server wrote it, headers and all (`setCookies` shows what they say about cookies):
 * what a browser does with an answer's cookies does not depend on what the page makes of it. A page that has given the
 * request up by then is not delivered to (`deliver` still returns).
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
  let setCookies: string[] = []
  await page.route(url, async (route) => {
    if (taken || route.request().method() !== method) return route.continue()
    if (matching !== undefined && !matching(route.request().postData())) return route.continue()
    taken = true
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    setCookies = setCookiesOf(response)
    reached((await response.json()) as T)
    await gate
    try {
      await route.fulfill({ response })
    } finally {
      fulfilled()
    }
  })
  return {
    /** The server has handled it; what the answer says. */
    reached: answered,
    /** The cookie lines of the answer, as the server wrote them (known once `reached` has resolved). */
    get setCookies(): string[] {
      return setCookies
    },
    async deliver(): Promise<void> {
      release()
      await given
      // The page reads the body and acts on it in the turns after the answer arrives: let two frames pass.
      await frames(page)
    },
  }
}

/** What the server answered to a request that was held before it reached the server. */
export type RealAnswer = { status: number; error: string | undefined; setCookies: string[] }

/**
 * Holds the first matching request of the page *before* the server has it, with what the browser attached to it (the
 * cookie of whoever made it, the person who may be gone when it is let go). `sendToServer` lets it through, with those
 * headers, and says what the server really answered; the answer is held again until `deliver`, as the server wrote it, so
 * that an answer that was refused, and what its cookie lines tell the browser, reach the page as they would have.
 */
export async function holdRequest(
  page: Page,
  url: RegExp,
  method: string,
  matching?: (body: string | null) => boolean,
) {
  let leave: () => void = () => undefined
  const sendGate = new Promise<void>((resolve) => {
    leave = resolve
  })
  let release: () => void = () => undefined
  const deliverGate = new Promise<void>((resolve) => {
    release = resolve
  })
  let parked: () => void = () => undefined
  const requested = new Promise<void>((resolve) => {
    parked = resolve
  })
  let answered: (answer: RealAnswer) => void = () => undefined
  const answer = new Promise<RealAnswer>((resolve) => {
    answered = resolve
  })
  let fulfilled: () => void = () => undefined
  const given = new Promise<void>((resolve) => {
    fulfilled = resolve
  })
  let taken = false
  await page.route(url, async (route) => {
    if (taken || route.request().method() !== method) return route.continue()
    if (matching && !matching(route.request().postData())) return route.continue()
    taken = true
    const headers = await route.request().allHeaders()
    // The cookie the browser attached: not every engine lists it among the headers of the request (WebKit does not), so it
    // is read from the jar as it is now, while the person who made the request is still the one signed in.
    const jar = await page.context().cookies(route.request().url())
    const cookie = headers.cookie ?? jar.map((entry) => `${entry.name}=${entry.value}`).join('; ')
    parked()
    await sendGate
    const response = await route.fetch({
      headers: cookie === '' ? headers : { ...headers, cookie },
    })
    const body = (await response.json().catch(() => undefined)) as
      | { error?: { code?: string } }
      | undefined
    answered({
      status: response.status(),
      error: body?.error?.code,
      setCookies: setCookiesOf(response),
    })
    await deliverGate
    try {
      await route.fulfill({ response })
    } finally {
      fulfilled()
    }
  })
  return {
    /** The page made the request; it is held, the server has not seen it. */
    requested,
    /** Lets the request through now and resolves with what the server really answered. The page has not been told. */
    async sendToServer(): Promise<RealAnswer> {
      leave()
      return await answer
    },
    async deliver(): Promise<void> {
      release()
      await given
      await frames(page)
    },
  }
}

/** The session cookie the browser holds right now (null: none). */
export async function sessionCookie(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies()
  return cookies.find((cookie) => /session_token$/.test(cookie.name))?.value ?? null
}

/** The status the server gives the page's own cookie, asked from inside the page, as its own requests are. */
export const identityStatus = (page: Page): Promise<number> =>
  page.evaluate(async () => (await fetch('/api/me', { cache: 'no-store' })).status)

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
