import { expect, test } from './support/fixtures.ts'
import { controlNetwork } from './support/network.ts'

/**
 * M6, the installed app (docs/01 section 3.5, docs/07 SEC-06, D-070, D-206): the service worker is registered through the
 * page's one Trusted Types policy; the manifest and the icons are in place; the worker keeps the public shell and nothing
 * else; the shell opens without a network and says what it cannot show. The worker is what these are about, so it is allowed
 * in every engine here (WebKit and Firefox block it elsewhere, playwright.config.ts).
 */
test.use({ serviceWorkers: 'allow' })
test('@smoke the worker registers under the page policy; the manifest and icons are in place; only the shell is kept', async ({
  page,
}) => {
  await page.goto('/login')
  const worker = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return { script: registration.active?.scriptURL, scope: registration.scope }
  })
  expect(worker.script).toMatch(/\/sw\.js$/)
  expect(worker.scope).toMatch(/\/$/)

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  )
  const manifestResponse = await page.request.get('/manifest.webmanifest')
  expect(manifestResponse.ok()).toBe(true)
  expect(manifestResponse.headers()['content-type']).toMatch(/json/)
  const manifest = (await manifestResponse.json()) as {
    icons: Array<{ src: string; sizes: string; purpose?: string }>
  }
  expect(manifest).toMatchObject({
    id: '/',
    name: 'ChatApp',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone'],
  })
  // The three icons a browser needs to offer installing: 192 and 512 for "any", and a maskable one.
  expect(manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`).sort()).toEqual([
    '192x192:any',
    '512x512:any',
    '512x512:maskable',
  ])
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src)
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toBe('image/png')
  }

  // What it keeps: the shell. Never an answer of the API, never a message or an attachment (SEC-08, SEC-34).
  const kept = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys())
        urls.push(new URL(request.url).pathname)
    }
    return urls
  })
  expect(kept).toContain('/index.html')
  expect(kept).toContain('/manifest.webmanifest')
  expect(kept.some((path) => path.startsWith('/api/'))).toBe(false)
  expect(kept.some((path) => path.startsWith('/ws'))).toBe(false)
  // The code highlighter's grammars are fetched when somebody pastes that language, not kept up front.
  expect(kept.filter((path) => /\/assets\/(cpp|typescript|csharp)-/.test(path))).toEqual([])
})

test('a plain string cannot name a worker script: the page policy allows exactly one thing (D-206)', async ({
  page,
  claimViolation,
  allowConsole,
}) => {
  claimViolation(
    /require-trusted-types-for/,
    'the test names a worker script with a plain string on purpose',
  )
  allowConsole(/TrustedScriptURL/, 'Chromium reports the refused script URL on the console', [
    'chromium',
  ])
  allowConsole(
    /TrustedScriptURL|Trusted ?Type/i,
    'WebKit reports the refused script URL on the console',
    ['webkit'],
  )
  await page.goto('/login')
  await page.evaluate(() => navigator.serviceWorker.ready)
  const outcome = await page.evaluate(async () => {
    try {
      // A real file of the app, so a refusal can only be the policy's, and a success would be a worker.
      const registration = await navigator.serviceWorker.register('/theme-init.js', {
        scope: '/themes/',
      })
      await registration.unregister()
      return 'registered'
    } catch (error) {
      return error instanceof Error ? error.name : 'unknown'
    }
  })
  expect(outcome).toBe('TypeError')
})

test('the shell opens without a network, says why it cannot show an account, and recovers by itself', async ({
  page,
  allowConsole,
  browserName,
}) => {
  // Playwright's offline emulation in WebKit fails the navigation itself ("WebKit encountered an internal error") before the
  // worker can answer it, so only Chromium can show this. A real Safari goes on the manual list (docs/08 section 10).
  test.skip(
    browserName === 'webkit',
    "Playwright's offline mode in WebKit refuses the navigation before the worker answers",
  )
  allowConsole(
    /ApiError: NETWORK/,
    'the identity check fails while offline, and the router reports the error it caught',
  )
  const network = await controlNetwork(page)
  await page.goto('/login')
  // The first visit installs the worker; the next load is the first one it controls.
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true)

  await network.goOffline()
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '没有网络连接' })).toBeVisible()
  await expect(page.getByText('需要联网验证你的身份')).toBeVisible()
  // No account is shown, nothing was asked of the server in the dark.
  await expect(page.getByRole('heading', { name: /^欢迎回来/ })).toHaveCount(0)

  await network.goOnline()
  // The network came back: the page tries again by itself and, with nobody signed in, ends at the sign-in page.
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
})
