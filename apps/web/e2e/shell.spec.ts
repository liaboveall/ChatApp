import { createVerifiedMember } from './support/api.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { animationsFinished, openSettings, signIn } from './support/ui.ts'

/** The app shell (docs/02 sections 3, 4, 7; M1b): shortcuts, appearance, time zone, layout tiers, keyboard access. */

const html = (page: import('@playwright/test').Page, attribute: string) =>
  page.evaluate((name) => document.documentElement.getAttribute(name), attribute)

test.describe('keyboard shortcuts', () => {
  test('@smoke the command palette, the assistant panel, settings and the help open from the keyboard', async ({
    page,
  }) => {
    const person = await createVerifiedMember('keys')
    await signIn(page, person.email, person.password)

    // Command palette: open, filter, run, and it closes.
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: '命令面板' })
    await expect(palette).toBeVisible()
    await expect(page.getByRole('combobox', { name: '命令面板' })).toBeFocused()
    await page.keyboard.type('深色')
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(palette).toBeHidden()
    expect(await html(page, 'data-theme')).toBe('dark')

    // Escape closes it without running anything.
    await page.keyboard.press('Control+k')
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    // Assistant panel toggles; the toolbar button reflects it.
    const toggle = page.getByRole('button', { name: '助手面板' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('Control+j')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('助手功能还在开发中')).toBeVisible()
    await page.keyboard.press('Control+j')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    // Help and settings.
    await page.keyboard.press('Control+/')
    await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+,')
    await expect(page).toHaveURL(/settings=appearance/)
    await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page).not.toHaveURL(/settings=/)
  })

  test('arrow keys move through the palette and Enter runs the highlighted command', async ({
    page,
  }) => {
    const person = await createVerifiedMember('palette')
    await signIn(page, person.email, person.password)
    await page.keyboard.press('Control+k')
    const options = page.getByRole('option')
    await expect(options.first()).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter') // "open account settings"
    await expect(page).toHaveURL(/settings=account/)
  })

  test('the skip link is the first stop and moves focus to the main area', async ({ page }) => {
    const person = await createVerifiedMember('skip')
    await signIn(page, person.email, person.password)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: /^欢迎回来/ })).toBeVisible()
    await page.keyboard.press('Tab')
    const skip = page.getByRole('link', { name: '跳到主要内容' })
    await expect(skip).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#main')).toBeFocused()
  })
})

test.describe('appearance', () => {
  test('@smoke the choices apply at once, survive a reload, and the stored values are applied before the app runs', async ({
    page,
  }) => {
    const person = await createVerifiedMember('look')
    await signIn(page, person.email, person.password)
    await openSettings(page, 'appearance')
    const dialog = page.getByRole('dialog')

    await dialog.getByRole('radio', { name: '深色' }).click()
    await dialog.getByRole('radio', { name: '紫' }).click()
    await dialog.getByRole('radio', { name: '清透' }).click()
    await dialog.getByRole('slider', { name: '界面字号' }).fill('2')
    await dialog.getByRole('switch', { name: '减少动态效果' }).click()
    expect(await html(page, 'data-theme')).toBe('dark')
    expect(await html(page, 'data-accent')).toBe('purple')
    expect(await html(page, 'data-glass')).toBe('clear')
    expect(await html(page, 'data-type-size')).toBe('2')
    expect(await html(page, 'data-reduce-motion')).toBe('true')

    // With the application's scripts blocked, the stored look is still on the page: theme-init.js applies it before first paint.
    await page.route('**/assets/*.js', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }),
    )
    await page.goto('/login')
    expect(await html(page, 'data-theme')).toBe('dark')
    expect(await html(page, 'data-accent')).toBe('purple')
    expect(await html(page, 'data-glass')).toBe('clear')
    expect(await html(page, 'data-type-size')).toBe('2')
    await page.unroute('**/assets/*.js')

    // And the app keeps it after a normal load; resetting returns to the defaults.
    await openSettings(page, 'appearance')
    await expect(page.getByRole('radio', { name: '深色' })).toBeChecked()
    await page.getByRole('button', { name: '恢复默认外观' }).click()
    expect(await html(page, 'data-theme')).toBeNull()
    expect(await html(page, 'data-accent')).toBeNull()
    expect(await html(page, 'data-glass')).toBeNull()
  })

  test('following the system, the page switches with the operating system', async ({ page }) => {
    const person = await createVerifiedMember('system')
    await signIn(page, person.email, person.password)
    await page.emulateMedia({ colorScheme: 'dark' })
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const dark = await background()
    await page.emulateMedia({ colorScheme: 'light' })
    const light = await background()
    expect(dark).not.toBe(light)
    expect(dark).toBe('rgb(0, 0, 0)')
    expect(light).toBe('rgb(242, 242, 247)')
  })

  test('the interface can be switched to English and back', async ({ page }) => {
    const person = await createVerifiedMember('lang')
    await signIn(page, person.email, person.password)
    await openSettings(page, 'appearance')
    await page.getByRole('radio', { name: 'English' }).click()
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
    await page.getByRole('radio', { name: '简体中文' }).click()
    await expect(page.getByRole('heading', { name: '外观' })).toBeVisible()
  })
})

test.describe('time zone', () => {
  test('follows the browser by default and is not overridden once fixed', async ({ browser }) => {
    const person = await createVerifiedMember('zone')
    // A browser in New York: the account's zone becomes New York without anyone asking.
    const ny = await (async () => {
      const context = await newContext(browser)
      await context.close()
      return browser.newContext({
        baseURL: test.info().project.use.baseURL,
        locale: 'zh-CN',
        timezoneId: 'America/New_York',
        extraHTTPHeaders: { 'x-forwarded-for': '10.9.9.9' },
      })
    })()
    const page = await ny.newPage()
    await signIn(page, person.email, person.password)
    await expect
      .poll(
        async () =>
          ((await (await page.request.get('/api/me')).json()) as { timezone: string }).timezone,
      )
      .toBe('America/New_York')

    // Fix it to Paris in Settings.
    await openSettings(page, 'account')
    await page.getByRole('radio', { name: '固定' }).click()
    await expect(page.getByText('时区已更新')).toBeVisible()
    await page.getByLabel('固定为').selectOption('Europe/Paris')
    await expect
      .poll(
        async () =>
          ((await (await page.request.get('/api/me')).json()) as { timezone: string }).timezone,
      )
      .toBe('Europe/Paris')

    // Another browser in Tokyo signs in: a fixed zone is not touched.
    const tokyo = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      locale: 'zh-CN',
      timezoneId: 'Asia/Tokyo',
      extraHTTPHeaders: { 'x-forwarded-for': '10.9.9.10' },
    })
    const other = await tokyo.newPage()
    await signIn(other, person.email, person.password)
    await other.waitForTimeout(1500)
    const me = (await (await other.request.get('/api/me')).json()) as {
      timezone: string
      settings: Record<string, unknown>
    }
    expect(me.timezone).toBe('Europe/Paris')
    expect(me.settings.timezoneAuto).toBe(false)

    // Back to following the browser: this one is Tokyo.
    await openSettings(other, 'account')
    await other.getByRole('radio', { name: '跟随浏览器' }).click()
    await expect
      .poll(
        async () =>
          ((await (await other.request.get('/api/me')).json()) as { timezone: string }).timezone,
      )
      .toBe('Asia/Tokyo')
    await ny.close()
    await tokyo.close()
  })
})

test.describe('layout', () => {
  for (const width of [320, 375, 600, 768, 1024, 1100, 1280, 1440]) {
    test(`@smoke nothing overflows sideways at ${width} px, signed out and signed in`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 })
      const overflow = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
      for (const path of ['/login', '/register', '/forgot-password', '/check-email']) {
        await page.goto(path)
        await expect(page.locator('main')).toBeVisible()
        expect(await overflow(), `${path} at ${width}`).toBeLessThanOrEqual(0)
      }
      const person = await createVerifiedMember(`w${width}`)
      await signIn(page, person.email, person.password)
      expect(await overflow(), `app at ${width}`).toBeLessThanOrEqual(0)
      await openSettings(page, 'account')
      expect(await overflow(), `settings at ${width}`).toBeLessThanOrEqual(0)
    })
  }

  test('under 768 px the sidebar is a drawer that traps nothing behind it and returns focus', async ({
    page,
  }) => {
    const person = await createVerifiedMember('drawer')
    await page.setViewportSize({ width: 600, height: 800 })
    await signIn(page, person.email, person.password)
    const nav = page.getByRole('navigation', { name: '会话' })
    await expect(nav).toBeHidden()
    const opener = page.getByRole('button', { name: '打开导航' })
    await opener.click()
    await expect(nav).toBeVisible()
    await expect(page.locator('main')).toHaveAttribute('inert', '')
    await page.keyboard.press('Escape')
    await expect(nav).toBeHidden()
    await expect(opener).toBeFocused()
  })

  test('between 1024 and 1279 px the inspector floats over the content instead of squeezing it', async ({
    page,
  }) => {
    const person = await createVerifiedMember('float')
    await page.setViewportSize({ width: 1100, height: 800 })
    await signIn(page, person.email, person.password)
    const main = page.locator('main')
    const before = await main.boundingBox()
    await page.keyboard.press('Control+j')
    const inspector = page.getByRole('complementary', { name: '详情与助手' })
    await expect(inspector).toBeVisible()
    // It slides in: measure the panel where it comes to rest, not a frame of the entrance.
    await animationsFinished(inspector)
    const after = await main.boundingBox()
    expect(after?.width).toBe(before?.width)
    expect((await inspector.boundingBox())?.width).toBeLessThanOrEqual(340)
  })

  test('at 1280 px and wider the inspector docks beside the content', async ({ page }) => {
    const person = await createVerifiedMember('dock')
    await page.setViewportSize({ width: 1440, height: 800 })
    await signIn(page, person.email, person.password)
    const main = page.locator('main')
    const before = (await main.boundingBox())?.width ?? 0
    await page.keyboard.press('Control+j')
    await expect(page.getByRole('complementary', { name: '详情与助手' })).toBeVisible()
    await expect.poll(async () => (await main.boundingBox())?.width ?? 0).toBeLessThan(before)
  })

  test('the sidebar width can be changed with the keyboard and is remembered', async ({ page }) => {
    const person = await createVerifiedMember('split')
    await page.setViewportSize({ width: 1440, height: 800 })
    await signIn(page, person.email, person.password)
    const splitter = page.getByRole('separator', { name: /调整侧栏宽度/ })
    await expect(splitter).toHaveAttribute('aria-valuenow', '280')
    await splitter.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(splitter).toHaveAttribute('aria-valuenow', '304')
    await page.keyboard.press('End')
    await expect(splitter).toHaveAttribute('aria-valuenow', '360')
    await page.keyboard.press('ArrowRight')
    await expect(splitter).toHaveAttribute('aria-valuenow', '360') // never past the maximum
    await page.reload()
    await expect(page.getByRole('separator', { name: /调整侧栏宽度/ })).toHaveAttribute(
      'aria-valuenow',
      '360',
    )
  })
})
