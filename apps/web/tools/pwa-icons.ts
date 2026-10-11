#!/usr/bin/env bun
/**
 * Renders the PNG icons of the installed app from the icon of the design (docs/02 section 10.5, D4 choice A): the two
 * "any" sizes, the maskable one (full-bleed square with the drawing shrunk into the 80% safe circle, so a round or squircle
 * mask never cuts it), the iOS touch icon and the small favicons. Run after changing `public/favicon.svg`:
 *
 *   bun apps/web/tools/pwa-icons.ts
 *
 * Chromium (already a dev dependency, for the end-to-end tests) draws them, so the gradients and curves are the browser's own.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUBLIC = join(ROOT, 'public')
const OUT = join(PUBLIC, 'icons')

/** The favicon without its rounded background plate, to draw it again on a full-bleed one. */
const source = readFileSync(join(PUBLIC, 'favicon.svg'), 'utf8')
const drawing = [...source.matchAll(/<path[^>]*\/>/g)].map((match) => match[0]).join('\n  ')
const gradients = /<defs>[\s\S]*?<\/defs>/.exec(source)?.[0]
if (!gradients || drawing === '')
  throw new Error('public/favicon.svg does not have the expected shape')

/**
 * The bubble spans x 20..108 and y 30..108 of the 128 box (centre 64,69). Scaled by 0.78 around its centre its far corners lie
 * about 46 units from the middle, inside the safe circle of radius 51.2 (80% of the width).
 */
const SAFE_SCALE = 0.78
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  ${gradients}
  <rect width="128" height="128" fill="url(#bg)"/>
  <g transform="translate(64 64) scale(${SAFE_SCALE}) translate(-64 -69)">
  ${drawing}
  </g>
</svg>`

type Job = { file: string; svg: string; size: number }
const jobs: Job[] = [
  { file: 'icon-192.png', svg: source, size: 192 },
  { file: 'icon-512.png', svg: source, size: 512 },
  { file: 'icon-maskable-512.png', svg: maskable, size: 512 },
  { file: 'apple-touch-icon.png', svg: maskable, size: 180 },
  { file: 'favicon-32.png', svg: source, size: 32 },
  { file: 'favicon-16.png', svg: source, size: 16 },
]

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
try {
  for (const job of jobs) {
    const page = await browser.newPage({ viewport: { width: job.size, height: job.size } })
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${job.size}px;height:${job.size}px}</style>${job.svg}`,
    )
    const png = await page.screenshot({ omitBackground: true, type: 'png' })
    writeFileSync(join(OUT, job.file), png)
    await page.close()
    console.log(`wrote public/icons/${job.file} (${job.size}×${job.size}, ${png.length} bytes)`)
  }
} finally {
  await browser.close()
}
