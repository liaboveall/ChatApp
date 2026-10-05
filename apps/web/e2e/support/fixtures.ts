import {
  type Browser,
  type BrowserContext,
  test as base,
  expect,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { CSP } from '../../tools/csp.ts'
import { fakeClientIp } from './accounts.ts'

/**
 * The checks every end-to-end test runs on every browser context it uses (docs/12 D-148, strengthening D-122): no policy
 * violation, no console error and no page exception that the test did not expect, and every document the site serves
 * carries the production Content Security Policy word for word (a preview server that forgot a header would otherwise
 * pass with zero "violations" because nothing was being enforced).
 *
 * A test registers its contexts: the default one is registered here, and `newContext()` registers the others and refuses
 * to work outside a test that has a registry. Anything a test knowingly provokes is declared with `allowConsole`; a
 * declaration that never matched fails the test, so allowances cannot be left behind by accident.
 */

type EngineName = 'chromium' | 'webkit' | 'firefox'

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

/**
 * What a browser says about a request that failed because the network was cut by `controlNetwork` (support/network.ts):
 * a file of the application that was still loading, or a fetch. It is expected while the test has the network cut, and
 * only then (D-165). The signed-in app loads the Markdown renderer and its code grammars in idle time, which can fall into
 * an outage whenever a test cuts the network a few seconds after signing in; nothing else may be reported.
 */
const FAILED_WHILE_CUT = [
  /^Failed to load resource: (net::ERR_INTERNET_DISCONNECTED|WebKit encountered an internal error)/,
  // Firefox says so of the page's attempt to reconnect (the apostrophe in the message is a typographic one).
  /Firefox can.t establish a connection to the server at wss?:\/\//,
]

/**
 * WebKit's console copy of the refusal that Playwright's own screenshot style meets (D-165; the event itself is dropped in
 * `instrument`, because it says there that it has no source). The console line cannot say so, and says the same of a real
 * refusal; a real one still fails the test, because the policy event that goes with every refusal is checked strictly.
 */
const WEBKIT_SCREENSHOT_STYLE =
  /^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive/

/** A failure is reported a moment after the request was made, so an outage reaches a little past its end. */
const OUTAGE_SLACK_MS = 1_000

/** The one page exception that is allowed: WebKit's notice about a ResizeObserver cycle, matched word for word (D-144). */
const WEBKIT_RESIZE_OBSERVER = 'ResizeObserver loop completed with undelivered notifications.'

type Allowance = {
  pattern: RegExp
  reason: string
  engines: readonly EngineName[] | undefined
  hits: number
}

type ViolationClaim = { pattern: RegExp; reason: string; hits: number }

/** What one test has seen across all of its contexts. */
class Registry {
  readonly contexts: BrowserContext[] = []
  readonly consoleErrors: { text: string; at: number; context: BrowserContext }[] = []
  /** When each context had its network cut (`until` is infinite while it still is). */
  readonly outages = new Map<BrowserContext, { from: number; until: number }[]>()
  readonly pageErrors: string[] = []
  readonly problems: string[] = []
  readonly violations = new Map<string, { text: string; where: string }>()
  readonly allowances: Allowance[] = []
  readonly claims: ViolationClaim[] = []

  constructor(
    readonly engine: EngineName,
    /** The site's own origin: only documents served from it are checked for the policy header. */
    readonly origin: string,
  ) {}
}

const registries = new WeakMap<TestInfo, Registry>()

/** Gives a context the probes and listeners every context of a test gets. */
async function instrument(context: BrowserContext, registry: Registry): Promise<void> {
  registry.contexts.push(context)
  // Violations reach the test the moment they happen, so one on a page that is closed later is not lost.
  await context.exposeBinding(
    '__reportViolation',
    (_source, id: string, text: string, where: string) => {
      registry.violations.set(id, { text, where })
    },
  )
  await context.addInitScript(() => {
    const reports: { id: string; text: string; where: string }[] = []
    const probe = { opened: 0, closes: [] as number[] }
    const w = window as unknown as {
      __csp: { id: string; text: string; where: string }[]
      __ws: typeof probe
      __reportViolation?: (id: string, text: string, where: string) => void
      WebSocket: typeof WebSocket
    }
    w.__csp = reports
    w.__ws = probe
    document.addEventListener('securitypolicyviolation', (event) => {
      // Playwright's own: WebKit and Firefox put an inline <style> into the page, from a script that has no file, whenever a
      // screenshot is taken (the end of a test, and the close of every context a test opened; D-165). A style that the
      // application makes comes from a file of the application or from the document, and has a source.
      if (
        event.violatedDirective === 'style-src-elem' &&
        event.blockedURI === 'inline' &&
        event.sourceFile === ''
      ) {
        return
      }
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text: `${event.violatedDirective}: ${event.blockedURI}`,
        // Where it came from, to read in a failure: the script (if any) and the start of the offending text.
        where: `${event.sourceFile || 'no source'}:${event.lineNumber}:${event.columnNumber} ${JSON.stringify(event.sample.slice(0, 120))}`,
      }
      reports.push(entry)
      w.__reportViolation?.(entry.id, entry.text, entry.where)
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
  context.on('console', (message) => {
    if (message.type() === 'error') {
      registry.consoleErrors.push({ text: message.text(), at: Date.now(), context })
    }
  })
  context.on('weberror', (webError) => {
    registry.pageErrors.push(webError.error().message)
  })
  context.on('response', (response) => {
    const request = response.request()
    if (!request.isNavigationRequest()) return
    const url = new URL(response.url())
    if (url.origin !== registry.origin || url.pathname.startsWith('/api/')) return
    const status = response.status()
    if (!((status >= 200 && status < 300) || status === 404)) return
    const policy = response.headers()['content-security-policy']
    if (policy !== CSP) {
      registry.problems.push(
        `the document ${url.pathname} was served with the policy ${JSON.stringify(policy)}, not the production one`,
      )
    }
  })
}

type Fixtures = {
  watch: undefined
  registry: Registry
  /** Declares a console error the test provokes on purpose. Must match at least once. */
  allowConsole: (pattern: RegExp, reason: string, engines?: readonly EngineName[]) => void
  /** Declares a policy violation the test provokes on purpose (the Trusted Types canary). Must match at least once. */
  claimViolation: (pattern: RegExp, reason: string) => void
}

export const test = base.extend<Fixtures>({
  // A different client address for every test, so the per-IP rate limits of one test never count against another.
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's dependencies from the destructuring; it has none.
  extraHTTPHeaders: async ({}, use) => {
    await use({ 'x-forwarded-for': fakeClientIp() })
  },
  registry: async ({ browserName, baseURL }, use, testInfo) => {
    const registry = new Registry(
      browserName as EngineName,
      new URL(baseURL ?? 'http://localhost').origin,
    )
    registries.set(testInfo, registry)
    await use(registry)
  },
  context: async ({ context, registry }, use) => {
    await instrument(context, registry)
    await use(context)
  },
  allowConsole: async ({ registry }, use) => {
    await use((pattern, reason, engines) => {
      registry.allowances.push({ pattern, reason, engines, hits: 0 })
    })
  },
  claimViolation: async ({ registry }, use) => {
    await use((pattern, reason) => {
      registry.claims.push({ pattern, reason, hits: 0 })
    })
  },
  // Runs for every test: whatever lands on a console or on the policy channel that is not part of normal operation fails it.
  // It depends on the default context so that it is torn down BEFORE that context is: Playwright takes the end-of-test
  // screenshot when the context goes, and WebKit and Firefox put an inline <style> into the page for a screenshot, which
  // the page's policy blocks and reports as a violation of its own (D-148). The check has to be over by then.
  watch: [
    async ({ registry, context: own }, use, testInfo) => {
      await use(undefined)
      try {
        await check(registry, testInfo)
      } finally {
        // The contexts a test opened with `newContext()` are not closed by Playwright: a page left open keeps its connection
        // and its timers running, and would still be on screen in the failure screenshots of every later test.
        await Promise.all(
          registry.contexts
            .filter((context) => context !== own)
            .map((context) => context.close().catch(() => undefined)),
        )
      }
    },
    { auto: true },
  ],
})

/** The checks of D-148, run when the test is over and its pages are still open. */
async function check(registry: Registry, testInfo: TestInfo): Promise<void> {
  // A test that already failed reports that failure alone. WebKit and Firefox inject an inline <style> into the page
  // for the failure screenshot, which the page's policy blocks and records as a violation of its own.
  if (testInfo.status !== testInfo.expectedStatus) return

  // What the pages recorded themselves, for the pages that are still open (the binding has the rest).
  for (const context of registry.contexts) {
    for (const page of context.pages()) {
      const own = await page
        .evaluate(
          () =>
            (window as unknown as { __csp?: { id: string; text: string; where: string }[] })
              .__csp ?? [],
        )
        .catch(() => [])
      for (const entry of own) registry.violations.set(entry.id, entry)
    }
  }

  const problems = [...registry.problems]
  const violations = [...registry.violations.values()]
    .filter(({ text }) => {
      const claim = registry.claims.find((candidate) => candidate.pattern.test(text))
      if (claim === undefined) return true
      claim.hits += 1
      return false
    })
    .map(({ text, where }) => `${text} (${where})`)
  for (const claim of registry.claims) {
    if (claim.hits === 0)
      problems.push(`the violation claimed for "${claim.reason}" never happened`)
  }

  const duringOutage = (context: BrowserContext, at: number): boolean =>
    (registry.outages.get(context) ?? []).some(
      (outage) => at >= outage.from && at <= outage.until + OUTAGE_SLACK_MS,
    )
  for (const { text, at, context } of registry.consoleErrors) {
    if (EXPECTED.some((pattern) => pattern.test(text))) continue
    if (registry.engine === 'webkit' && WEBKIT_SCREENSHOT_STYLE.test(text)) continue
    if (FAILED_WHILE_CUT.some((pattern) => pattern.test(text)) && duringOutage(context, at))
      continue
    const allowance = registry.allowances.find(
      (candidate) =>
        candidate.pattern.test(text) &&
        (candidate.engines === undefined || candidate.engines.includes(registry.engine)),
    )
    if (allowance !== undefined) {
      allowance.hits += 1
      continue
    }
    problems.push(`console: ${text}`)
  }
  for (const allowance of registry.allowances) {
    const applies = allowance.engines === undefined || allowance.engines.includes(registry.engine)
    if (applies && allowance.hits === 0) {
      problems.push(`the console error allowed for "${allowance.reason}" never appeared`)
    }
  }

  let observerNotices = 0
  for (const text of registry.pageErrors) {
    if (registry.engine === 'webkit' && text === WEBKIT_RESIZE_OBSERVER) {
      observerNotices += 1
      continue
    }
    problems.push(`pageerror: ${text}`)
  }
  if (observerNotices > 0) {
    testInfo.annotations.push({
      type: 'allowed page exception',
      description: `${observerNotices} × ${WEBKIT_RESIZE_OBSERVER}`,
    })
  }

  expect(violations, 'Content Security Policy violations').toEqual([])
  expect(problems, 'unexpected errors in the browser').toEqual([])
}

export { expect }

/** Records that the network of a context was cut or restored, for the checks at the end of the test (`FAILED_WHILE_CUT`). */
export function networkCut(context: BrowserContext, cut: boolean): void {
  const registry = registries.get(test.info())
  if (registry === undefined)
    throw new Error('networkCut() was called outside a test with a registry (D-148)')
  const outages = registry.outages.get(context) ?? []
  registry.outages.set(context, outages)
  if (cut) outages.push({ from: Date.now(), until: Number.POSITIVE_INFINITY })
  else {
    const open = outages.at(-1)
    if (open !== undefined) open.until = Date.now()
  }
}

/**
 * A fresh browser context with the project's settings and its own client address, for a second person or device. It is
 * registered with the running test, which then holds it to the same checks as the default one (D-148).
 */
export async function newContext(
  browser: Browser,
  overrides: { timezoneId?: string } = {},
): Promise<BrowserContext> {
  const info = test.info()
  const registry = registries.get(info)
  if (registry === undefined) {
    throw new Error('newContext() was called by a test that has no registry of contexts (D-148)')
  }
  const { baseURL, locale, timezoneId } = info.project.use
  const context = await browser.newContext({
    baseURL,
    locale,
    timezoneId: overrides.timezoneId ?? timezoneId,
    extraHTTPHeaders: { 'x-forwarded-for': fakeClientIp() },
  })
  await instrument(context, registry)
  return context
}

/** CSP violations the page has recorded since it loaded. */
export async function cspViolations(page: Page): Promise<string[]> {
  const entries = await page.evaluate(
    () => (window as unknown as { __csp?: { text: string }[] }).__csp ?? [],
  )
  return entries.map((entry) => entry.text)
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
