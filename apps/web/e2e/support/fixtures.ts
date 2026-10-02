import {
  type Browser,
  type BrowserContext,
  test as base,
  expect,
  type Page,
} from '@playwright/test'
import { fakeClientIp } from './accounts.ts'

/**
 * Console messages that are part of normal operation. The browser reports every fetch that the server answers with a
 * 4xx as a console error ("Failed to load resource"), and the API answers refusals that way on purpose: the anonymous
 * identity probe with 401, a wrong code with 400, a taken name with 409. A 5xx is not expected and still fails the test,
 * as does anything the application itself logs. A WebSocket that the server closes by design is logged by some engines.
 */
const EXPECTED = [
  /Failed to load resource: the server responded with a status of 4\d\d/,
  /WebSocket connection to .* failed/i,
  /4401|4403/,
]

export const test = base.extend<{ watch: undefined }>({
  // A different client address for every test, so the per-IP rate limits of one test never count against another.
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from the destructuring; it has none.
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'x-forwarded-for': fakeClientIp() })
  },
  page: async ({ page }, use) => {
    await installProbes(page)
    await use(page)
  },
  // Runs for every test: whatever lands on the console that is not part of normal operation fails it.
  watch: [
    async ({ page }, use, testInfo) => {
      const problems: string[] = []
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          !EXPECTED.some((pattern) => pattern.test(message.text()))
        ) {
          problems.push(`console: ${message.text()}`)
        }
      })
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
      await use(undefined)
      // A test that already failed reports that failure alone. WebKit and Firefox inject an inline <style> into the page
      // for the failure screenshot, which the page's policy blocks and records as a violation of its own.
      if (testInfo.status !== testInfo.expectedStatus) return
      // The policy the page ran under is the production one: nothing may have been blocked.
      const blocked = await page
        .evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
        .catch(() => [])
      expect(blocked, 'Content Security Policy violations').toEqual([])
      expect(problems, 'unexpected errors in the browser console').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

/**
 * Probes every page gets before its own scripts run: CSP violations are recorded, and WebSocket connections are
 * counted with the close codes they ended with (the protocol's codes are part of what is under test, docs/05 section 4.1).
 */
export async function installProbes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const reports: string[] = []
    const probe = { opened: 0, closes: [] as number[] }
    const w = window as unknown as {
      __csp: string[]
      __ws: typeof probe
      WebSocket: typeof WebSocket
    }
    w.__csp = reports
    w.__ws = probe
    document.addEventListener('securitypolicyviolation', (event) => {
      reports.push(`${event.violatedDirective}: ${event.blockedURI}`)
    })
    const Native = w.WebSocket
    w.WebSocket = class extends Native {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args)
        this.addEventListener('open', () => {
          probe.opened += 1
        })
        this.addEventListener('close', (event) => {
          probe.closes.push(event.code)
        })
      }
    }
  })
}

/** A fresh browser context with the project's settings and its own client address, for a second person or device. */
export async function newContext(browser: Browser): Promise<BrowserContext> {
  const { baseURL, locale, timezoneId } = test.info().project.use
  return browser.newContext({
    baseURL,
    locale,
    timezoneId,
    extraHTTPHeaders: { 'x-forwarded-for': fakeClientIp() },
  })
}

/** CSP violations the page has recorded since it loaded. */
export function cspViolations(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
}

/** WebSocket connections opened by the page and the close codes of those that ended. */
export function socketProbe(page: Page): Promise<{ opened: number; closes: number[] }> {
  return page.evaluate(
    () =>
      (window as unknown as { __ws?: { opened: number; closes: number[] } }).__ws ?? {
        opened: 0,
        closes: [],
      },
  )
}
