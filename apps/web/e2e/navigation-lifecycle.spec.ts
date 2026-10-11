import { createVerifiedMember } from './support/api.ts'
import { expect, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

test.use({ serviceWorkers: 'block' })

for (const navigation of ['reloading', 'navigating'] as const) {
  test(`${navigation} while the notification read is pending discards the old document and the new page reads successfully`, async ({
    page,
  }) => {
    const member = await createVerifiedMember('reload')
    await signIn(page, member.email, member.password)
    let taken = false
    let release: () => void = () => undefined
    let reached: () => void = () => undefined
    let delivered: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = new Promise<void>((resolve) => {
      reached = resolve
    })
    const finished = new Promise<void>((resolve) => {
      delivered = resolve
    })
    await page.route('**/api/notifications?*', async (route) => {
      if (taken) return route.continue()
      taken = true
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      reached()
      await gate
      try {
        await route.fulfill({ response })
      } finally {
        delivered()
      }
    })
    await page.getByRole('button', { name: /^通知/ }).click()
    await pending
    // A refresh timer can also fire while the old document is being replaced. The rejection is deliberately handled: a
    // WebKit protocol notice from that cancellation must be distinguished from an uncaught exception on a live page.
    await page.evaluate(() => {
      window.addEventListener(
        'pagehide',
        () => {
          void fetch('/api/notifications?limit=30', {
            credentials: 'same-origin',
            cache: 'no-store',
          }).catch(() => undefined)
        },
        { once: true },
      )
    })
    const newRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/notifications' && response.ok(),
    )
    try {
      const response = navigation === 'reloading' ? await page.reload() : await page.goto('/')
      expect(response).not.toBeNull()
      await newRead
      await expect(page.getByRole('heading', { name: `欢迎回来，${member.name}` })).toBeVisible()
      await expect(page.getByRole('button', { name: /^通知/ })).toHaveAccessibleName('通知')
    } finally {
      release()
      await finished
    }
  })
}
