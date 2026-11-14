import { type Browser, chromium, expect, type Page, test } from '@playwright/test'
import { setVisualTime } from './clock.ts'

/**
 * The name in a mention has to stand on the line of the sentence it is part of.
 *
 * Chromium places the text of a box that sits in a line a fraction of a pixel off the baseline when anything pushes the
 * text down from the top of that box by a length that is not a whole number of the pixels it lays the page out in:
 * padding, a margin or an edge of some width above the text. At a display scaling that is not a whole number (125%,
 * 150%, 175%, or browser zoom) those are physical pixels, so 5px of padding is 6.25 of them. The name of a mention then
 * stood a device pixel above or below the words beside it, in some messages and not in others, depending on where the
 * line fell (2026-11-14, reported from a display at 150%).
 *
 * (Tailwind reads this file for class names like every other file of the package: a comment here that names a utility
 * as a bare word adds that utility to the stylesheet. Naming the CSS property for an edge did exactly that and gave
 * every code block, whose markup from the rendering library carries that class, a frame.)
 *
 * Two things hide this from an ordinary check. A screenshot at 100% does not show it. And an emulated device scale
 * factor (`deviceScaleFactor` of a browser context) does not reproduce it: there the page is still laid out in CSS
 * pixels. Only a browser started with `--force-device-scale-factor` behaves like a scaled display, so this launches
 * its own browsers. It does not compare pictures: it writes the same glyphs inside a mention and beside it, in a bubble
 * of one's own, and measures on which pixel row their lowest stroke is painted.
 */

const STORY = '/iframe.html?id=timeline-rows--mentions&viewMode=story&globals=theme:light'
/** Ten bubbles, each an eighth of a pixel lower than the one before: the offset decides which way a fraction rounds. */
const ROWS = 10
const GLYPHS = '三三'

type Box = { x: number; y: number; width: number; height: number }
type Pair = { inside: Box; beside: Box }

async function writeSheet(page: Page, step: string): Promise<Pair[]> {
  return await page.evaluate(
    ([rows, glyphs, size]) => {
      if (size !== '0') document.documentElement.setAttribute('data-type-size', size)
      const host = document.createElement('div')
      host.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;background:var(--bg-content);padding:14px;' +
        'display:flex;flex-direction:column;gap:5px;align-items:flex-start'
      for (let i = 0; i < rows; i++) {
        const bubble = document.createElement('div')
        bubble.className = 'bubble bubble--out'
        bubble.style.marginTop = `${(i * 0.13).toFixed(2)}px`
        const line = document.createElement('p')
        const mention = document.createElement('span')
        mention.className = 'mention'
        // The weight of the text beside it, so both strokes are equally thick and can be compared row for row.
        mention.style.fontWeight = '400'
        const inside = document.createElement('span')
        inside.dataset.ink = 'inside'
        inside.textContent = glyphs
        mention.append(inside)
        const beside = document.createElement('span')
        beside.dataset.ink = 'beside'
        beside.textContent = glyphs
        line.append(mention, ' ', beside)
        bubble.append(line)
        host.append(bubble)
      }
      document.body.append(host)
      const box = (element: Element | null) => {
        if (!element) throw new Error('glyphs not found')
        const rect = element.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      return [...host.children].map((bubble) => ({
        inside: box(bubble.querySelector('[data-ink="inside"]')),
        beside: box(bubble.querySelector('[data-ink="beside"]')),
      }))
    },
    [ROWS, GLYPHS, step] as const,
  )
}

/**
 * For every pair: how many device pixels the lowest stroke of the glyphs in the mention is below (positive) or above
 * the lowest stroke of the glyphs beside it. The text is white on the accent, so ink is where red is high.
 */
async function strokeOffsets(page: Page, pairs: Pair[], scale: number): Promise<number[]> {
  const shot = await page.screenshot({ type: 'png' })
  const probe = await page.context().newPage()
  try {
    return await probe.evaluate(
      async ([encoded, list, factor]) => {
        const image = new Image()
        image.src = `data:image/png;base64,${encoded}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('no canvas')
        context.drawImage(image, 0, 0)
        const lowestStroke = (box: {
          x: number
          y: number
          width: number
          height: number
        }): number => {
          const left = Math.round(box.x * factor)
          const top = Math.round((box.y - 2) * factor)
          const width = Math.round(box.width * factor)
          const height = Math.round((box.height + 4) * factor)
          const pixels = context.getImageData(left, top, width, height)
          const ink: number[] = []
          for (let y = 0; y < pixels.height; y++) {
            let sum = 0
            for (let x = 0; x < pixels.width; x++) {
              sum += Math.max(0, (pixels.data[(y * pixels.width + x) * 4] ?? 0) - 120) / 135
            }
            ink.push(sum / pixels.width)
          }
          const at = (y: number): number => ink[y] ?? 0
          let end = ink.length - 1
          while (end > 0 && at(end) < 0.15) end--
          let start = end
          while (start > 0 && at(start - 1) >= 0.15) start--
          let mass = 0
          let moment = 0
          for (let y = start - 1; y <= end + 1; y++) {
            mass += at(y)
            moment += at(y) * y
          }
          if (mass === 0) throw new Error('no ink found')
          return top + moment / mass
        }
        return list.map((pair) => lowestStroke(pair.inside) - lowestStroke(pair.beside))
      },
      [shot.toString('base64'), pairs, scale] as const,
    )
  } finally {
    await probe.close()
  }
}

// 110% stands for browser zoom, the others are the display scalings Windows offers below 200%.
for (const scale of [1.1, 1.25, 1.5, 1.75]) {
  test.describe(`display scaling ${Math.round(scale * 100)}%`, () => {
    let browser: Browser

    test.beforeAll(async () => {
      browser = await chromium.launch({
        args: [`--force-device-scale-factor=${scale}`, '--window-size=700,820'],
      })
    })
    test.afterAll(async () => {
      await browser.close()
    })

    // The text size setting: -1 to +3, 0 being the default 15px.
    for (const step of ['-1', '0', '1', '2', '3']) {
      test(`the name in a mention stands on the line of its sentence at text size ${step}`, async ({
        baseURL,
      }) => {
        // No viewport and no device scale factor of its own: the page takes both from the browser, as on a display.
        // (Both are named because the runner adds the project's defaults to every context made in a test.)
        const context = await browser.newContext({
          baseURL,
          viewport: null,
          deviceScaleFactor: undefined,
          locale: 'zh-CN',
        })
        try {
          const page = await context.newPage()
          await setVisualTime(page)
          await page.goto(STORY)
          await page.locator('.mention').first().waitFor()
          await page.evaluate(() => document.fonts.ready)
          expect(await page.evaluate(() => devicePixelRatio)).toBeCloseTo(scale, 3)
          const pairs = await writeSheet(page, step)
          const offsets = await strokeOffsets(page, pairs, scale)
          expect(offsets).toHaveLength(ROWS)
          // Half a device pixel is far more than the glass under the name does to the edge of a stroke (measured:
          // 0.11 at most). A name that is off its line is off by a whole pixel, in some of the rows.
          for (const offset of offsets) expect(Math.abs(offset)).toBeLessThan(0.5)
        } finally {
          await context.close()
        }
      })
    }
  })
}
