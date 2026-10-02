import type { Page } from '@playwright/test'
import { createVerifiedMember } from './support/api.ts'
import { expect, socketProbe, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/** The realtime connection from the browser's side (docs/05 section 4.1, M1b acceptance). */

/** Opens a WebSocket from the page and returns the close code the server ends it with. */
const closeCodeOf = (page: Page, target: string): Promise<number> =>
  page.evaluate(
    (url) =>
      new Promise<number>((resolve) => {
        const socket = new WebSocket(url)
        socket.onclose = (event) => resolve(event.code)
      }),
    target,
  )

test('@smoke an anonymous connection is closed with 4401', async ({ page }) => {
  await page.goto('/login')
  const code = await closeCodeOf(page, `ws://${new URL(page.url()).host}/ws`)
  expect(code).toBe(4401)
})

test('@smoke a connection from a foreign origin is closed with 4403', async ({ page }) => {
  // The same server under another host name: the browser sends Origin http://127.0.0.1:4173, which is not the site.
  await page.goto('http://127.0.0.1:4173/login')
  const code = await closeCodeOf(page, 'ws://127.0.0.1:4173/ws')
  expect(code).toBe(4403)
})

test('@smoke the signed-in app connects under the page policy and stays connected', async ({
  page,
}) => {
  const person = await createVerifiedMember('socket')
  await signIn(page, person.email, person.password)
  await expect.poll(async () => (await socketProbe(page)).opened).toBe(1)
  // Several heartbeat intervals later it is still the same single connection.
  await page.waitForTimeout(3_000)
  const probe = await socketProbe(page)
  expect(probe.opened).toBe(1)
  expect(probe.closes).toEqual([])
})
