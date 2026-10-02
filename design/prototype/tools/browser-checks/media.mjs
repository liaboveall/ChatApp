// System preference checks: reduced transparency, reduced motion, dark colour scheme, host theme hand-off,
// text size steps. Uses CSS media emulation, so no OS setting is touched.
import { launch, PROTO_URL, suite } from './cdp.mjs'

const s = suite('media')
const page = await launch({ width: 1440, height: 900 })
const ev = (e) => page.eval(e)
let nav = 0
// `animated` leaves the page's own animations on, which the reduced-motion checks need (static=1 would hide them).
const open = async (hash = '', animated = false) => {
  await page.goto(
    `${PROTO_URL}?m=${++nav}#scene=channel&fresh=1&nostore=1&${animated ? '' : 'static=1&'}quiet=1${hash}`,
  )
  await page.sleep(300)
}
const glassCount = () =>
  ev(
    "[...document.querySelector('.window').querySelectorAll('*')].filter(e => { const c = getComputedStyle(e); const f = c.backdropFilter || c.webkitBackdropFilter; return f && f !== 'none' }).length",
  )

try {
  // reduced transparency: every glass level becomes opaque and no backdrop filter remains
  await page.media({ 'prefers-reduced-transparency': 'reduce' })
  await open('&glass=clear')
  s.check(
    'reduced transparency: --glass-alpha is 100% even when the level is Clear',
    (await ev(
      "getComputedStyle(document.documentElement).getPropertyValue('--glass-alpha').trim()",
    )) === '100%',
  )
  s.check(
    'reduced transparency: no backdrop-filter layers remain',
    (await glassCount()) === 0,
    String(await glassCount()),
  )
  await ev("window.__proto.bus.emit('settings:open', 'appearance')")
  await page.sleep(300)
  s.check(
    'reduced transparency: the settings control is locked to Opaque and says why',
    (await ev(
      'document.querySelector(\'.sheet [aria-label="透明度"] button[aria-checked="true"]\')?.textContent',
    )) === '不透明' &&
      (await ev(
        "document.querySelector('.sheet').textContent.includes('系统已开启「减少透明度」')",
      )),
  )
  await page.shot('media-reduced-transparency')
  await page.media({ 'prefers-reduced-transparency': 'no-preference' })

  // reduced motion: animations collapse to a very short fade
  await page.media({ 'prefers-reduced-motion': 'reduce' })
  await open('', true)
  const orb = await ev("getComputedStyle(document.querySelector('.orb')).animationDuration")
  s.check(
    'reduced motion: wallpaper drift animation is effectively off',
    parseFloat(orb) < 0.001,
    orb,
  )
  const tr = await ev("getComputedStyle(document.querySelector('.icon-btn')).transitionDuration")
  s.check('reduced motion: transitions are at most 150 ms', parseFloat(tr) <= 0.15, tr)
  const tp = await ev("getComputedStyle(document.querySelector('.icon-btn')).transitionProperty")
  s.check('reduced motion: no transform transitions remain', !tp.includes('transform'), tp)
  await page.media({ 'prefers-reduced-motion': 'no-preference' })
  await open('', true)
  const orbFull = await ev("getComputedStyle(document.querySelector('.orb')).animationDuration")
  s.check(
    'control: without the preference the wallpaper animation runs (so the check above means something)',
    parseFloat(orbFull) > 1,
    orbFull,
  )

  // the in-app switch does the same
  await open('')
  await ev("window.__proto.setPref('reduceMotion', true)")
  s.check(
    'reduce-motion preference sets the root class',
    await ev("document.documentElement.classList.contains('reduce-motion')"),
  )
  await ev("window.__proto.setPref('reduceMotion', false)")

  // system dark mode with no data-theme attribute
  await page.media({ 'prefers-color-scheme': 'dark' })
  await open('')
  s.check(
    'system dark: color-scheme is dark',
    (await ev('getComputedStyle(document.documentElement).colorScheme')) === 'dark',
  )
  s.check(
    'system dark: content surface resolves to #1C1C1E',
    (await ev("getComputedStyle(document.querySelector('.main')).backgroundColor")) ===
      'rgb(28, 28, 30)',
    await ev("getComputedStyle(document.querySelector('.main')).backgroundColor"),
  )
  await page.media({ 'prefers-color-scheme': 'light' })

  // host theme hand-off (the artifact viewer sets data-theme itself); must never loop
  await open('')
  await ev("document.documentElement.setAttribute('data-theme', 'dark')")
  await page.sleep(300)
  s.check(
    'host sets dark while the app follows the system: app stays dark',
    (await ev("document.documentElement.getAttribute('data-theme')")) === 'dark',
  )
  await ev("window.__proto.setPref('theme', 'light')")
  s.check(
    'an explicit app choice overrides the host',
    (await ev("document.documentElement.getAttribute('data-theme')")) === 'light',
  )
  await ev("document.documentElement.setAttribute('data-theme', 'dark')")
  await page.sleep(300)
  s.check(
    'the app re-asserts its explicit choice if the host changes the attribute',
    (await ev("document.documentElement.getAttribute('data-theme')")) === 'light',
  )
  await ev("window.__proto.setPref('theme', 'system')")
  await page.sleep(200)
  s.check(
    'back to system: the host value (dark) is restored',
    (await ev("document.documentElement.getAttribute('data-theme')")) === 'dark',
  )
  s.check('the page is still responsive after all those changes', (await ev('1 + 1')) === 2)

  // text size steps do not break the layout
  for (const step of [-1, 0, 1, 2, 3]) {
    await ev(`window.__proto.setPref('typeSize', ${step})`)
    await page.sleep(150)
    const over = await ev(
      "document.querySelector('.window').scrollWidth - document.querySelector('.window').clientWidth",
    )
    s.check(
      `text size ${step >= 0 ? '+' : ''}${step}: no horizontal overflow`,
      over <= 0,
      String(over),
    )
  }
  await page.shot('media-type-size-3')
} catch (err) {
  s.check('suite ran to the end', false, err.message)
} finally {
  s.check(
    'no console errors during the run',
    page.consoleLog.length === 0,
    page.consoleLog.slice(0, 3).join(' | '),
  )
  await page.close()
}
process.exit(s.done() ? 1 : 0)
