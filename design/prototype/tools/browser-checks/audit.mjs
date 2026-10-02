// Collects screenshots and text element geometry for the pixel contrast audit (AT-21).
// usage: node audit.mjs <set>   set: full | worst
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, PROTO_URL, SHOTS } from './cdp.mjs'

const set = process.argv[2] ?? 'worst'
const OUT = join(SHOTS, 'audit')
mkdirSync(OUT, { recursive: true })
const URL = PROTO_URL
const ACCENTS = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'graphite']
const GLASS = ['clear', 'standard', 'tinted', 'opaque']
const THEMES = ['light', 'dark']

// [label, selector, colour source]
const TARGETS = {
  channel: [
    ['sidebar title', '.s-item:not([aria-current]) .s-item__title > span', 'color'],
    ['sidebar preview', '.s-item__preview', 'color'],
    ['sidebar time', '.s-item__time', 'color'],
    ['sidebar section', '.s-section__toggle > span', 'color'],
    ['sidebar search', '.sidebar .search__text', 'color'],
    ['sidebar selected title', '.s-item[aria-current="true"] .s-item__title > span', 'color'],
    ['sidebar user', '.sidebar__user-name', 'color'],
    ['sidebar user status', '.sidebar__user-status', 'color'],
    ['toolbar title', '.toolbar__title > span', 'color'],
    ['toolbar subtitle', '.toolbar__sub', 'color'],
    ['composer placeholder', '#composer-input', 'placeholder'],
    ['own bubble', '.bubble--out p', 'color'],
    ['incoming bubble', '.bubble--in p', 'color'],
    ['bubble link', '.bubble--in a', 'color'],
    ['unread divider', '.unread-div', 'color'],
    ['date separator', '.date-sep span', 'color'],
    ['mention pill', '.bubble--in .mention, .msg--mention .mention', 'color'],
    ['unread badge', '.s-item .badge:not(.badge--muted)', 'color'],
    ['agent sender', '.msg-sender', 'color'],
  ],
  menu: [
    ['menu item', '.menu__item span:not(.menu__hint)', 'color'],
    ['menu hint', '.menu__hint', 'color'],
    ['menu label', '.menu__label', 'color'],
  ],
  palette: [
    ['palette row', '.palette__row[data-active="false"] .palette__label', 'color'],
    ['palette sub', '.palette__row[data-active="false"] .palette__sub', 'color'],
    ['palette group', '.palette__group', 'color'],
    ['palette input', '#palette-input', 'placeholder'],
    ['palette foot', '.palette__foot', 'color'],
  ],
  inspector: [
    ['inspector name', '.inspector .t-headline', 'color'],
    ['inspector sub', '.inspector .t-sub', 'color'],
    ['inspector section', '.inspector__h', 'color'],
    ['inspector row', '.inspector .row__title', 'color'],
    ['inspector help', '.inspector .row__help', 'color'],
  ],
  settings: [
    ['sheet tab', '.sheet__tab', 'color'],
    ['sheet title', '.sheet__head h2', 'color'],
    ['group title', '.group__title', 'color'],
    ['row title', '.row__title', 'color'],
    ['row help', '.row__help', 'color'],
  ],
}

const collector = (targets) => `(() => {
  const out = []
  const parseTxt = (el, kind) => kind === 'placeholder' ? getComputedStyle(el, '::placeholder').color : getComputedStyle(el).color
  for (const [label, sel, kind] of ${JSON.stringify(targets)}) {
    let n = 0
    for (const el of document.querySelectorAll(sel)) {
      if (n >= 5) break
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      if (el.closest('[inert]') && !el.closest('.sheet, .palette, .menu, .dialog')) continue
      let r
      if (kind === 'placeholder') {
        const c = document.createElement('canvas').getContext('2d'); c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily
        const w = c.measureText(el.placeholder).width; const b = el.getBoundingClientRect()
        r = { x: b.left + parseFloat(cs.paddingLeft), y: b.top + parseFloat(cs.paddingTop), w, h: parseFloat(cs.lineHeight) || 20 }
      } else {
        const range = document.createRange(); range.selectNodeContents(el); const rects = [...range.getClientRects()].filter(q => q.width > 1 && q.height > 1)
        if (rects.length === 0) continue
        const x1 = Math.min(...rects.map(q => q.left)), y1 = Math.min(...rects.map(q => q.top)), x2 = Math.max(...rects.map(q => q.right)), y2 = Math.max(...rects.map(q => q.bottom))
        r = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
      }
      if (r.w < 4 || r.h < 4 || r.x < 0 || r.y < 0 || r.x + r.w > innerWidth || r.y + r.h > innerHeight) continue
      // Skip text that is clipped by a scroll container or covered by something else.
      const hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2)
      if (!hit || !(el.contains(hit) || hit.contains(el))) continue
      out.push({ label, sel, rect: r, color: parseTxt(el, kind), text: (el.textContent || el.placeholder || '').trim().slice(0, 24) })
      n++
    }
  }
  return out
})()`

const page = await launch({ width: 1440, height: 900 })
const index = []
let nav = 0
const open = async (scene) => {
  await page.goto(`${URL}?a=${++nav}#scene=${scene}&fresh=1&nostore=1&static=1&quiet=1&width=fit`)
  await page.sleep(250)
}
try {
  const combos = []
  if (set === 'full')
    for (const t of THEMES) for (const a of ACCENTS) for (const g of GLASS) combos.push([t, a, g])
  else
    for (const t of THEMES)
      for (const a of ['blue', 'yellow', 'graphite'])
        for (const g of ['clear', 'tinted']) combos.push([t, a, g])

  const setPrefs = (t, a, g) =>
    page.eval(
      `(() => { const p = window.__proto; p.setPref('theme', '${t}'); p.setPref('accent', '${a}'); p.setPref('glass', '${g}') })()`,
    )

  for (const [t, a, g] of combos) {
    const base = `${t}-${a}-${g}`
    // A: the channel screen
    await open('channel')
    await setPrefs(t, a, g)
    await page.sleep(200)
    await page.shot(`audit/${base}-channel`)
    index.push({
      shot: `audit/${base}-channel.png`,
      combo: base,
      scene: 'channel',
      elements: await page.eval(collector(TARGETS.channel)),
    })
  }
  // The text-bearing overlays on the worst combinations only
  const overlayCombos =
    set === 'full'
      ? combos.filter(
          ([, a, g]) =>
            ['blue', 'yellow', 'graphite'].includes(a) && ['clear', 'tinted'].includes(g),
        )
      : combos
  for (const [t, a, g] of overlayCombos) {
    const base = `${t}-${a}-${g}`
    await open('channel')
    await setPrefs(t, a, g)
    await page.click('.toolbar__actions button[aria-label="更多"]')
    await page.sleep(250)
    await page.shot(`audit/${base}-menu`)
    index.push({
      shot: `audit/${base}-menu.png`,
      combo: base,
      scene: 'menu',
      elements: await page.eval(collector(TARGETS.menu)),
    })
    await open('palette')
    await setPrefs(t, a, g)
    await page.sleep(250)
    await page.shot(`audit/${base}-palette`)
    index.push({
      shot: `audit/${base}-palette.png`,
      combo: base,
      scene: 'palette',
      elements: await page.eval(collector(TARGETS.palette)),
    })
    await page.viewport(1100, 800)
    await open('w1024')
    await setPrefs(t, a, g)
    await page.sleep(250)
    await page.shot(`audit/${base}-inspector`)
    index.push({
      shot: `audit/${base}-inspector.png`,
      combo: base,
      scene: 'inspector',
      elements: await page.eval(collector(TARGETS.inspector)),
    })
    await page.viewport(1440, 900)
    await open('settings-appearance')
    await setPrefs(t, a, g)
    await page.sleep(300)
    await page.shot(`audit/${base}-settings`)
    index.push({
      shot: `audit/${base}-settings.png`,
      combo: base,
      scene: 'settings',
      elements: await page.eval(collector(TARGETS.settings)),
    })
  }
  writeFileSync(join(OUT, 'index.json'), JSON.stringify(index))
  console.log(
    `audit collected: ${index.length} screenshots, ${index.reduce((n, e) => n + e.elements.length, 0)} text elements`,
  )
  if (page.consoleLog.length) console.log('console:', page.consoleLog.slice(0, 3).join(' | '))
} finally {
  await page.close()
}
