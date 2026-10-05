/**
 * Measuring the timeline (docs/12 D-149). The conversation of ten thousand messages is made by `scripts/e2e-stack.ts`
 * before the API starts; this file reads who is in it, signs the people in once per run (sign-in attempts per account are
 * limited, and every test needs a session), and holds the probes the tests inject into the page. The application has no
 * measuring code of its own: the one thing it offers is the read-only `data-loaded-count` on the timeline element.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Browser, chromium, type Page } from '@playwright/test'
import { apiContext } from './api.ts'
import { newContext, test } from './fixtures.ts'
import { GPU_LAUNCH } from './gpu.ts'

/**
 * A test that measures, in a Chromium of its own: what an earlier test left in the browser (a renderer still being torn down, the
 * graphics process's caches) changes the frames of the next one by a factor of two, so every measurement starts from a
 * browser that has done nothing else (D-162).
 */
export const measuringTest = test.extend<{ measuring: Browser }>({
  measuring: async ({ watch: _watch }, use) => {
    const browser = await chromium.launch(GPU_LAUNCH)
    await use(browser)
    await browser.close()
  },
})

export type PerfPerson = { id: string; username: string; email: string; password: string }

export type PerfFixture = {
  conversationId: string
  groupName: string
  firstSeq: number
  people: { a: PerfPerson; b: PerfPerson; c: PerfPerson }
}

export function perfFixture(): PerfFixture {
  const path = fileURLToPath(new URL('../../../../.test-runs/e2e/perf.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as PerfFixture
}

type Cookies = Awaited<
  ReturnType<Awaited<ReturnType<typeof apiContext>>['storageState']>
>['cookies']
const sessions = new Map<string, Cookies>()

/** Signs a person in over HTTP once and keeps the session cookies for every later context of the run. */
async function sessionOf(person: PerfPerson): Promise<Cookies> {
  const known = sessions.get(person.id)
  if (known !== undefined) return known
  const api = await apiContext()
  const response = await api.post('/api/auth/sign-in/email', {
    data: { email: person.email, password: person.password },
  })
  if (!response.ok()) throw new Error(`sign-in of ${person.username} failed: ${response.status()}`)
  const { cookies } = await api.storageState()
  await api.dispose()
  sessions.set(person.id, cookies)
  return cookies
}

/**
 * Whether this browser draws with graphics hardware. Headless Chromium falls back to software (SwiftShader, llvmpipe) when
 * it finds none, and then a frame with a translucent blurred bar over a moving list takes three frames' time: such a run is
 * measured and attached but not asserted (D-161). The frame budget of D-149 is for hardware compositing.
 */
export async function hardwareCompositing(page: Page): Promise<boolean> {
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl')
    const info = gl?.getExtension('WEBGL_debug_renderer_info')
    return gl === null || gl === undefined || !info
      ? ''
      : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
  })
  return renderer !== '' && !/swiftshader|llvmpipe|softpipe|software/i.test(renderer)
}

/** A new context signed in as one of the three, on the page of the performance group once its list is on screen. */
export async function openPerfGroup(browser: Browser, who: 'a' | 'b' | 'c'): Promise<Page> {
  const fixture = perfFixture()
  const context = await newContext(browser)
  await context.addCookies(await sessionOf(fixture.people[who]))
  const page = await context.newPage()
  await page.goto(`/c/${fixture.conversationId}`)
  await page.waitForFunction(
    () => Number(document.querySelector('.timeline')?.getAttribute('data-loaded-count') ?? 0) > 0,
    undefined,
    { timeout: 30_000 },
  )
  // The opening of a cold page (the Markdown chunk, the first page of messages, the first draw) has its own long frames and
  // its own budget (first interaction); what is measured is reading and scrolling. So wait until a whole second of frames
  // has gone by without one taking 100 ms (counted from the frames themselves: a blocked page shows as a long gap, which a
  // timer-based check could miss, D-162).
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const giveUp = performance.now() + 20_000
        let last = performance.now()
        let calm = 0
        const tick = (now: number): void => {
          const gap = now - last
          last = now
          calm = gap < 100 ? calm + gap : 0
          if (calm >= 1_000) resolve()
          else if (now > giveUp) reject(new Error('the page did not settle'))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
  return page
}

export type ScrollStats = {
  frames: number
  /** Gaps between animation frames, in milliseconds. */
  p50: number
  p95: number
  /** Frames that took 50 ms or more, and 100 ms or more. */
  slow50: number
  slow100: number
  /** Long animation frames reported by the browser (Chromium only; null elsewhere). */
  longFrames: { over50: number; over100: number } | null
  /** The least of the fractions of the viewport that rows covered, over all frames. */
  minCoverage: number
}

/**
 * Scrolls the timeline at a steady speed for a while and reports what the frames were like. Coverage is measured at the
 * start of every frame, before the script moves again, so it is what the person saw after the last move and the render
 * that followed it.
 */
export function measureScroll(
  page: Page,
  options: { pixelsPerSecond: number; durationMs: number },
): Promise<ScrollStats> {
  return page.evaluate(async ({ pixelsPerSecond, durationMs }) => {
    const scroller = document.querySelector<HTMLElement>('.timeline')
    if (scroller === null) throw new Error('no timeline')
    const inner = scroller.firstElementChild
    const gaps: number[] = []
    let minCoverage = 1
    let long = { over50: 0, over100: 0 }
    let supportsLong = false
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) long.over50 += 1
          if (entry.duration >= 100) long.over100 += 1
        }
      })
      observer.observe({ type: 'long-animation-frame', buffered: false })
      supportsLong = true
    } catch {
      long = { over50: 0, over100: 0 }
    }

    const coverage = (): number => {
      if (inner === null) return 0
      const view = scroller.getBoundingClientRect()
      let covered = 0
      for (const item of inner.children) {
        const box = item.getBoundingClientRect()
        covered += Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top))
      }
      return covered / view.height
    }

    await new Promise<void>((resolve) => {
      let last = performance.now()
      const started = last
      const tick = (now: number): void => {
        gaps.push(now - last)
        const share = coverage()
        if (gaps.length > 2 && share < minCoverage) minCoverage = share
        const dt = now - last
        last = now
        if (now - started >= durationMs) {
          resolve()
          return
        }
        scroller.scrollTop -= (pixelsPerSecond * dt) / 1000
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    // The browser reports long frames a moment after they end.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const sorted = gaps.slice(2).sort((x, y) => x - y)
    const at = (p: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
    return {
      frames: sorted.length,
      p50: at(0.5),
      p95: at(0.95),
      slow50: sorted.filter((gap) => gap >= 50).length,
      slow100: sorted.filter((gap) => gap >= 100).length,
      longFrames: supportsLong ? long : null,
      minCoverage,
    }
  }, options)
}

/**
 * Brings `pages` older pages into memory with the "load earlier messages" control (the one a keyboard or screen reader user
 * has), which loads whatever the scroll position: scrolling to the top and waiting is not reliable while the list corrects
 * its own offset after every page. Fails loudly when a page does not arrive.
 */
export function loadOlderPages(page: Page, pages: number): Promise<number> {
  return page.evaluate(async (count) => {
    const scroller = document.querySelector<HTMLElement>('.timeline')
    if (scroller === null) throw new Error('no timeline')
    const loaded = (): number => Number(scroller.getAttribute('data-loaded-count') ?? 0)
    const frames = (n: number): Promise<void> =>
      new Promise((resolve) => {
        const step = (left: number): void => {
          if (left <= 0) resolve()
          else requestAnimationFrame(() => step(left - 1))
        }
        step(n)
      })
    for (let i = 0; i < count; i += 1) {
      const before = loaded()
      const button = document.querySelector<HTMLElement>('.timeline-more button')
      if (button === null || button.closest('[hidden]') !== null) break
      button.click()
      const end = performance.now() + 10_000
      while (performance.now() < end && loaded() <= before) await frames(1)
      if (loaded() <= before) throw new Error(`page ${i + 1} of older messages did not load`)
      await frames(4)
    }
    return loaded()
  }, pages)
}

export type LoadAllStats = {
  loads: number
  /** How many commits the reader's row was compared across (a probe that compared nothing proves nothing). */
  compared: number
  /** The largest movement of the row the reader is looking at across any commit that added or removed rows, in pixels. */
  maxShift: number
  /** Every commit that moved that row by more than 1.5 px: what the commit was, and how far the row was one and two frames later. */
  bigShifts: string[]
  /** How often a step into the load zone had to be taken again because no page came (a slow answer, a pause after a refusal). */
  retries: number
  /** The longest wait for a page, in milliseconds. */
  slowestLoadMs: number
  /** The most messages loaded at any moment, between a page arriving and the trim that follows it. */
  maxMessages: number
  /** The most messages loaded once the trim after a page has landed. */
  maxSettled: number
  maxSeqElements: number
  maxElements: number
  /** Animation frames that took 200 ms or more. */
  longFrames: number
  /** What the browser says it was doing in those (Chromium's long animation frames), for the report. */
  longFrameDetails: string[]
  reachedStart: boolean
}

/**
 * Reads the conversation from the newest end to the oldest by keeping the scroll position near the top, the way a reader
 * dragging the scrollbar up would, and tracks the reader's row across every commit that changes what is loaded: loading a
 * page at the top and trimming the far end later. Nothing else moves the list during that time, so the row must not move.
 */
export function loadAllOlder(page: Page, options: { maxLoads: number }): Promise<LoadAllStats> {
  return page.evaluate(async ({ maxLoads }) => {
    const scroller = document.querySelector<HTMLElement>('.timeline')
    if (scroller === null) throw new Error('no timeline')
    const loaded = (): number => Number(scroller.getAttribute('data-loaded-count') ?? 0)
    const stats = {
      loads: 0,
      compared: 0,
      maxShift: 0,
      bigShifts: [] as string[],
      retries: 0,
      slowestLoadMs: 0,
      maxMessages: loaded(),
      maxSettled: 0,
      maxSeqElements: 0,
      maxElements: 0,
      longFrames: 0,
      longFrameDetails: [] as string[],
      reachedStart: false,
    }
    const sample = (): void => {
      stats.maxMessages = Math.max(stats.maxMessages, loaded())
      stats.maxSeqElements = Math.max(
        stats.maxSeqElements,
        document.querySelectorAll('[data-seq]').length,
      )
      stats.maxElements = Math.max(stats.maxElements, document.getElementsByTagName('*').length)
    }

    // The reader's row: the first article that starts below the toolbar. Its distance from the top of the window is
    // remembered every frame and compared at every commit.
    const tracked: { element: Element | null; top: number } = { element: null, top: 0 }
    const pickAnchor = (): void => {
      const view = scroller.getBoundingClientRect()
      let found: Element | null = null
      let top = 0
      for (const article of scroller.querySelectorAll('article[data-seq]')) {
        const box = article.getBoundingClientRect()
        if (box.top >= view.top + 72) {
          found = article
          top = box.top
          break
        }
      }
      tracked.element = found
      tracked.top = top
    }
    const remember = (): void => {
      if (tracked.element?.isConnected) tracked.top = tracked.element.getBoundingClientRect().top
    }
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < 200) continue
          const frame = entry as PerformanceEntry & {
            scripts?: { sourceURL?: string; invoker?: string; duration: number }[]
            blockingDuration?: number
          }
          const scripts = (frame.scripts ?? [])
            .map(
              (script) =>
                `${script.invoker ?? '?'} ${Math.round(script.duration)}ms ${script.sourceURL?.split('/').pop() ?? ''}`,
            )
            .slice(0, 3)
            .join('; ')
          stats.longFrameDetails.push(
            `${Math.round(entry.startTime)}ms: ${Math.round(entry.duration)}ms [${scripts}]`,
          )
        }
      }).observe({ type: 'long-animation-frame', buffered: false })
    } catch {
      // Not every engine reports long animation frames.
    }
    let lastFrame = performance.now()
    let watching = true
    const frame = (now: number): void => {
      if (now - lastFrame >= 200) stats.longFrames += 1
      lastFrame = now
      remember()
      sample()
      if (watching) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)

    // Every commit that changes how many messages are loaded.
    let lastCount = loaded()
    const observer = new MutationObserver(() => {
      const count = loaded()
      if (tracked.element?.isConnected) {
        const anchor = tracked.element
        const baseline = tracked.top
        const moved = Math.abs(anchor.getBoundingClientRect().top - baseline)
        stats.maxShift = Math.max(stats.maxShift, moved)
        stats.compared += 1
        if (moved > 1.5) {
          // Whether it is a displacement that stays (a visible jump) or one that the list corrects before the next paint.
          const what = `${count > lastCount ? 'page' : 'trim'} → ${count} loaded, row seq ${anchor.getAttribute('data-seq')}, moved ${Math.round(moved)} px`
          requestAnimationFrame(() => {
            const one = Math.abs(anchor.getBoundingClientRect().top - baseline)
            requestAnimationFrame(() => {
              const two = Math.abs(anchor.getBoundingClientRect().top - baseline)
              stats.bigShifts.push(
                `${what}; one frame later ${Math.round(one)} px, two ${Math.round(two)} px`,
              )
            })
          })
        }
      }
      lastCount = count
      sample()
    })
    observer.observe(scroller, { attributes: true, attributeFilter: ['data-loaded-count'] })

    const frames = (n: number): Promise<void> =>
      new Promise((resolve) => {
        const step = (left: number): void => {
          if (left <= 0) resolve()
          else requestAnimationFrame(() => step(left - 1))
        }
        step(n)
      })
    const waitFor = async (test: () => boolean, ms: number): Promise<boolean> => {
      const end = performance.now() + ms
      while (performance.now() < end) {
        if (test()) return true
        await frames(1)
      }
      return test()
    }

    while (stats.loads < maxLoads && document.querySelector('.history-boundary') === null) {
      const before = loaded()
      // Settle just outside the zone in which the list asks for older messages (600 px from the top), step into the zone, and
      // take the reader's row as it is after the step: the first row below the toolbar then. Both happen in one task, before
      // anything can render or be asked for. (The list moves itself a little before it settles, from estimated to measured
      // heights, so a row chosen before the step can be a screenful away after it, and no longer drawn.)
      scroller.scrollTop = 800
      await frames(3)
      scroller.scrollTop = 500
      pickAnchor()
      const askedAt = performance.now()
      let grew = await waitFor(() => loaded() > before, 4_000)
      // The list corrects its own offset after a page arrives and can swallow a step: take the step again (a few times).
      for (
        let again = 0;
        !grew && again < 3 && document.querySelector('.history-boundary') === null;
        again += 1
      ) {
        stats.retries += 1
        scroller.scrollTop = 800
        await frames(3)
        scroller.scrollTop = 500
        pickAnchor()
        grew = await waitFor(() => loaded() > before, 4_000)
      }
      if (!grew) {
        if (document.querySelector('.history-boundary') !== null) break
        throw new Error('older messages stopped arriving')
      }
      stats.slowestLoadMs = Math.max(stats.slowestLoadMs, Math.round(performance.now() - askedAt))
      stats.loads += 1
      // Let the later trim of the far end land too, and keep watching the same row through it. The wait is for the trim
      // itself (the window is back to its size), not for a count of frames: when the page is slow for a moment the trim comes
      // late, and the next step, which moves the scroll position by hand, would land between the page and its trim and be
      // measured as the list's own movement.
      await frames(2)
      await waitFor(() => loaded() <= 2_000, 2_000)
      await frames(2)
      stats.maxSettled = Math.max(stats.maxSettled, loaded())
    }
    stats.reachedStart = document.querySelector('.history-boundary') !== null
    watching = false
    observer.disconnect()
    return stats
  }, options)
}

/**
 * Writes the numbers of a measurement where a person will find them: attached to the test report, noted on the test, and, on
 * CI, appended to the job summary (docs/12 D-149: what is not asserted there is still shown).
 */
export async function recordMeasurement(
  info: import('@playwright/test').TestInfo,
  name: string,
  numbers: object,
): Promise<void> {
  const text = JSON.stringify(numbers, null, 2)
  // The list reporter shows what the process prints; the numbers belong in the log of every run.
  console.log(`${name} (${info.project.name}): ${JSON.stringify(numbers)}`)
  await info.attach(`${name}.json`, { body: text, contentType: 'application/json' })
  info.annotations.push({ type: name, description: JSON.stringify(numbers) })
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary !== undefined && summary !== '') {
    appendFileSync(summary, `**${name}** (${info.project.name})\n\n\`\`\`json\n${text}\n\`\`\`\n\n`)
  }
}
