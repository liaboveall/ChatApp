import type { Page } from '@playwright/test'
import { createVerifiedMember } from './support/api.ts'
import {
  composer,
  createGroupApi,
  message,
  myId,
  sendApi,
  sendFromComposer,
  signedIn,
} from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import { openPerfGroup } from './support/perf.ts'
import { signIn } from './support/ui.ts'

/**
 * AT-21 for the conversation (docs/08, docs/02 section 7): the keyboard walks a conversation of ten thousand messages and
 * the focus is never swallowed by the virtual list; and at 320 CSS pixels (400% zoom on a desktop screen) a person can still
 * get to a conversation, write in it and look at its details, with nothing spilling sideways.
 */
const activeSeq = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const element = document.activeElement
    return element?.matches('article[data-seq]') ? Number(element.getAttribute('data-seq')) : null
  })

const spillsSideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)

test('the keyboard walks a long conversation, and the message that has the focus is never taken away', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const page = await openPerfGroup(browser, 'c')
  await page.locator('article[data-seq="10000"]').focus()
  expect(await activeSeq(page)).toBe(10_000)

  for (let i = 0; i < 30; i += 1) await page.keyboard.press('ArrowUp')
  await expect.poll(() => activeSeq(page)).toBe(9_970)
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => activeSeq(page)).toBe(9_971)
  const beforePage = await page.locator('.timeline').evaluate((element) => ({
    offset: element.scrollTop,
    height: element.clientHeight,
  }))
  await page.keyboard.press('PageUp')
  // Messages have different heights, and the composer includes the assistant privacy notice.
  // Verify an actual page of scrolling, rather than assuming a fixed number of messages fits.
  await expect.poll(async () => (await activeSeq(page)) ?? 10_000).toBeLessThan(9_970)
  await expect
    .poll(
      async () =>
        beforePage.offset -
        (await page.locator('.timeline').evaluate((element) => element.scrollTop)),
    )
    .toBeGreaterThan(beforePage.height / 2)
  const here = await activeSeq(page)

  // The wheel takes the list several screens away. The row with the focus is far outside the window on screen,
  // and it is still there, and still has the focus: a virtual list must not hand it to the body.
  const timelineBounds = await page.locator('.timeline').boundingBox()
  if (!timelineBounds) throw new Error('timeline is unavailable')
  // Stay clear of the sidebar splitter and code blocks, which can consume their own wheel events.
  const wheelPoint = { x: timelineBounds.x + 64, y: timelineBounds.y + timelineBounds.height / 2 }
  expect(
    await page.evaluate(
      ({ x, y }) => document.querySelector('.timeline')?.contains(document.elementFromPoint(x, y)),
      wheelPoint,
    ),
  ).toBe(true)
  await page.locator('.timeline').hover({ position: { x: 64, y: timelineBounds.height / 2 } })
  // Allow the browser's hit-test state to catch up with the pointer, then use ordinary wheel gestures.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -3000)
  await page.waitForTimeout(800)
  await expect
    .poll(async () => Number(await page.locator('.timeline').getAttribute('data-loaded-count')))
    .toBeGreaterThan(50)
  expect(await activeSeq(page)).toBe(here)

  // End returns to the newest page if paging detached the bounded window. Home goes to the
  // oldest message in the window that is now loaded, which can differ from the pre-End window.
  await page.keyboard.press('End')
  await expect.poll(() => activeSeq(page)).toBe(10_000)
  const loadedAfterEnd = Number(await page.locator('.timeline').getAttribute('data-loaded-count'))
  expect(loadedAfterEnd).toBeGreaterThan(0)
  await page.keyboard.press('Home')
  await expect.poll(() => activeSeq(page)).toBe(10_001 - loadedAfterEnd)

  // Escape leaves the list for the message field.
  await page.keyboard.press('Escape')
  await expect(composer(page)).toBeFocused()
})

test.describe('at 320 px', () => {
  test.use({ viewport: { width: 320, height: 640 } })

  test('a person can get to a conversation, write in it and read its details, and nothing spills sideways', async ({
    page,
  }) => {
    const person = await createVerifiedMember('narrow')
    const friend = await createVerifiedMember('friend')
    const apiP = await signedIn(person)
    const apiF = await signedIn(friend)
    const name = `窄屏群${Date.now().toString(36)}`
    const groupId = await createGroupApi(apiP, name, [await myId(apiF)])
    await sendApi(apiF, groupId, '朋友发来的一条消息')

    await signIn(page, person.email, person.password)
    expect(await spillsSideways(page)).toBe(false)

    // The conversation list is a drawer; choosing a conversation closes it.
    await page.getByRole('button', { name: '打开导航' }).click()
    const nav = page.getByRole('navigation', { name: '会话' })
    await expect(nav).toBeVisible()
    await nav.getByRole('link', { name: new RegExp(`^${name}`) }).click()
    // The drawer is in the way of what it led to, so it closes (a choice of the conversation that is open closes it too).
    await expect(nav).toBeHidden()
    await expect(composer(page)).toBeVisible()
    await expect(message(page, '朋友发来的一条消息')).toBeVisible()
    expect(await spillsSideways(page)).toBe(false)

    await sendFromComposer(page, '窄屏幕上发的一条消息')
    await expect(message(page, '窄屏幕上发的一条消息')).toBeVisible()

    // Opening the drawer again and choosing the conversation that is already open closes it as well.
    await page.getByRole('button', { name: '打开导航' }).click()
    await expect(nav).toBeVisible()
    await nav.getByRole('link', { name: new RegExp(`^${name}`) }).click()
    await expect(nav).toBeHidden()

    // The details open over the page and can be read and closed.
    await page.getByRole('button', { name: '成员与详情' }).click()
    await expect(page.locator('.details')).toBeVisible()
    await expect(page.locator('.details .member').first()).toBeVisible()
    expect(await spillsSideways(page)).toBe(false)
    await page.getByRole('button', { name: '关闭面板' }).click()
    await expect(page.locator('.details')).toBeHidden()
    expect(await spillsSideways(page)).toBe(false)
  })
})
