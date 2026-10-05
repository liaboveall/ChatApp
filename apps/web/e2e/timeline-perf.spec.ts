import type { Page } from '@playwright/test'
import { sidebarItem } from './support/chat.ts'
import { expect } from './support/fixtures.ts'
import {
  hardwareCompositing,
  loadAllOlder,
  loadOlderPages,
  measureScroll,
  openPerfGroup,
  perfFixture,
  recordMeasurement,
  measuringTest as test,
} from './support/perf.ts'

/**
 * "Scrolling stays smooth in a conversation of ten thousand messages" (docs/11 M2b acceptance, docs/12 D-149). The
 * conversation is made by the E2E stack before the API starts; the probes are injected here, the application has no
 * measuring code. Assertions about how fast things render run on a developer's machine; on CI the same numbers are
 * measured and attached but not asserted, because a shared runner's CPU is not under our control. Everything that is
 * deterministic (how far a row moves, how much is in the page, where the "new messages" line is) is asserted everywhere.
 */
const LOCAL = !process.env.CI

test.describe.configure({ mode: 'serial' })

const record = recordMeasurement

const timeline = (page: Page) => page.locator('.timeline')

test('@perf T4: the group opens at the new-messages line beside seq 9,901, and the unread count stays 100 until the bottom is read', async ({
  measuring,
}) => {
  const fixture = perfFixture()
  const page = await openPerfGroup(measuring, 'b')
  const divider = page.locator('.unread-div')
  await expect(divider).toBeVisible()

  // In the window, and the message right below it is the first unread one.
  const line = await divider.boundingBox()
  const view = await timeline(page).boundingBox()
  if (line === null || view === null) throw new Error('no boxes')
  expect(line.y).toBeGreaterThanOrEqual(view.y)
  expect(line.y + line.height).toBeLessThanOrEqual(view.y + view.height)
  const nextSeq = await divider.evaluate((element) => {
    const articles = [...document.querySelectorAll('article[data-seq]')]
    const next = articles.find(
      (article) => element.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING,
    )
    return Number(next?.getAttribute('data-seq'))
  })
  expect(nextSeq).toBe(9_901)

  // Reading a little does not read it all: the badge stays at 100 (it is claimed only when the bottom is on screen).
  const item = sidebarItem(page, fixture.groupName)
  await expect(item).toHaveAccessibleName(new RegExp(`^${fixture.groupName}, 100 条未读`))
  await timeline(page).evaluate((element) => element.scrollBy(0, 400))
  await page.waitForTimeout(1_800)
  await expect(item).toHaveAccessibleName(/100 条未读/)

  // Down to the end, as a reader would keep scrolling while newer pages arrive below: now it is read.
  await expect
    .poll(
      async () => {
        await timeline(page).evaluate((element) => {
          element.scrollTop = element.scrollHeight
        })
        return page.getByRole('button', { name: /回到最新/ }).count()
      },
      { timeout: 20_000 },
    )
    .toBe(0)
  await expect(item).not.toHaveAccessibleName(/未读/, { timeout: 20_000 })
})

test('@perf T3: jumping to a quoted message settles within 1.8 s without drifting, and back to latest ends at the bottom', async ({
  measuring,
}) => {
  const page = await openPerfGroup(measuring, 'b')
  await timeline(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  const reply = page.locator('article[data-seq="10000"]')
  await expect(reply).toBeVisible()
  await expect(reply.locator('.bubble__quote')).toBeVisible()

  // Click the quote of seq 10,000 (it quotes seq 3,000) and follow where seq 3,000 is for 1.8 seconds.
  const jump = await page.evaluate(async () => {
    const started = performance.now()
    document.querySelector<HTMLElement>('article[data-seq="10000"] .bubble__quote')?.click()
    const tops: number[] = []
    let appeared: number | null = null
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const target = document.querySelector('article[data-seq="3000"]')
        if (target !== null) {
          appeared ??= performance.now() - started
          tops.push(target.getBoundingClientRect().top)
        }
        if (performance.now() - started >= 1_800) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const scroller = document.querySelector('.timeline')
    const box = document.querySelector('article[data-seq="3000"]')?.getBoundingClientRect()
    const view = scroller?.getBoundingClientRect()
    return {
      appeared,
      frames: tops.length,
      // Once it has appeared, the row stays where it is (the first frames after it appears are the placement itself).
      drift: tops.length > 5 ? Math.max(...tops.slice(5)) - Math.min(...tops.slice(5)) : null,
      centred:
        box !== undefined && view !== undefined
          ? Math.abs(box.top + box.height / 2 - (view.top + view.height / 2))
          : null,
    }
  })
  await record(test.info(), 'T3-jump', jump)
  expect(jump.appeared).not.toBeNull()
  expect(jump.drift).not.toBeNull()
  expect(jump.drift as number).toBeLessThanOrEqual(1.5)
  await expect(page.locator('article[data-seq="3000"]')).toBeVisible()

  // Back to the latest: the button appears, and the end of the list is within 2 px of the bottom.
  await page.getByRole('button', { name: /回到最新/ }).click()
  await expect
    .poll(
      async () =>
        timeline(page).evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      { timeout: 5_000 },
    )
    .toBeLessThanOrEqual(2)
  await expect(page.locator('article[data-seq="10000"]')).toBeVisible()
})

test('@perf T1: fast scrolling through what is in memory: smooth frames, full coverage, and no requests', async ({
  measuring,
}) => {
  test.setTimeout(180_000)
  const page = await openPerfGroup(measuring, 'b')
  // Bring about a thousand messages into memory, then stand in the middle of them, far from both ends.
  const inMemory = await loadOlderPages(page, 12)
  expect(inMemory).toBeGreaterThan(1_000)
  await timeline(page).evaluate((element) => {
    element.scrollTop = element.scrollHeight / 2
  })
  await page.waitForTimeout(800)

  const requests: string[] = []
  page.on('request', (request) => {
    if (/\/api\/conversations\/[^/]+\/messages/.test(request.url())) requests.push(request.url())
  })
  // The first moving frames of a cold page pay for the graphics card's first rasters; a steady scroll is what is measured (D-162).
  await measureScroll(page, { pixelsPerSecond: 2_500, durationMs: 800 })
  await page.waitForTimeout(300)
  const stats = await measureScroll(page, { pixelsPerSecond: 2_500, durationMs: 3_000 })
  await record(test.info(), 'T1', stats)

  // Deterministic everywhere: it was all in memory.
  expect(requests).toEqual([])
  expect(stats.frames).toBeGreaterThan(5)
  // The frame budget is for a developer's machine with hardware compositing (D-149, D-161); elsewhere it is recorded.
  if (!LOCAL || !(await hardwareCompositing(page))) return
  expect(stats.frames).toBeGreaterThan(120)
  expect(stats.p50).toBeLessThanOrEqual(17.5)
  expect(stats.p95).toBeLessThanOrEqual(25)
  expect(stats.slow100).toBe(0)
  expect(stats.slow50 / stats.frames).toBeLessThanOrEqual(0.01)
  expect(stats.minCoverage).toBeGreaterThanOrEqual(0.9)
  if (stats.longFrames !== null) {
    expect(stats.longFrames.over100).toBe(0)
    expect(stats.longFrames.over50 / stats.frames).toBeLessThanOrEqual(0.01)
  }
})

test("@perf T2: reading all the way to the oldest message: the reader's row never moves, and the page stays small", async ({
  measuring,
}) => {
  test.setTimeout(600_000)
  const page = await openPerfGroup(measuring, 'b')
  const stats = await loadAllOlder(page, { maxLoads: 400 })
  await record(test.info(), 'T2', stats)

  expect(stats.reachedStart).toBe(true)
  expect(stats.loads).toBeGreaterThanOrEqual(95)
  // How far the row the reader looks at moves across every commit that loads or trims (px). The row is found again in at
  // least nine commits of ten (a probe that compared nothing would prove nothing).
  expect(stats.compared).toBeGreaterThanOrEqual(Math.floor(stats.loads * 0.9))
  expect(stats.maxShift, stats.bigShifts.join('\n')).toBeLessThanOrEqual(1.5)
  // The page stays small, however far back the reader goes.
  expect(stats.maxSeqElements).toBeLessThanOrEqual(150)
  expect(stats.maxElements).toBeLessThanOrEqual(8_000)
  // 2,000 once the trim after a page has landed; between the page and its trim (one commit, D-151) one page more.
  expect(stats.maxSettled).toBeLessThanOrEqual(2_000)
  expect(stats.maxMessages).toBeLessThanOrEqual(2_100)
  expect(stats.longFrames).toBe(0)
  // At the very top the first row is the start of the conversation.
  await expect(page.locator('.history-boundary')).toBeVisible()
})
