// D1 font comparison on the machine running the check: which fonts exist, and how the system stack and
// Inter render the same screen. Inter is embedded in the page (D-112), so no network is needed. D4 chose Inter
// (D-113): it is the default, "system" is only the comparison switch.
import { launch, PROTO_URL } from './cdp.mjs'

const page = await launch({ width: 1440, height: 900 })
const ev = (e) => page.eval(e)
let nav = 0
const open = async (hash) => {
  await page.goto(`${PROTO_URL}?f=${++nav}#${hash}`)
  await page.sleep(400)
}
try {
  await open('scene=notes-fonts&fresh=1&nostore=1&static=1&quiet=1')
  const env = await ev(`(async () => {
    const hi = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['platform', 'platformVersion', 'fullVersionList']).catch(() => ({})) : {}
    return { ua: navigator.userAgent, platform: hi.platform, platformVersion: hi.platformVersion, dpr: devicePixelRatio }
  })()`)
  console.log('environment:', JSON.stringify(env))
  const fonts = await ev(
    "[...document.querySelectorAll('.n-card')].filter(c => /有|没有|内嵌/.test(c.textContent) && c.querySelector('.t-callout')).map(c => c.textContent.replace(/\\s+/g, ' ').trim())",
  )
  console.log('fonts on this device:', fonts.join(' | '))

  // The default state (no font parameter): D4 chose Inter, so it must be the active font and its face must be loaded.
  await open('scene=channel&fresh=1&nostore=1&static=1&quiet=1')
  await page.sleep(600)
  const initial = await ev(`({
    dataFont: document.documentElement.getAttribute('data-font'),
    family: getComputedStyle(document.body).fontFamily.slice(0, 60),
    interFaces: [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Inter').map((f) => f.status),
  })`)
  console.log('default state:', JSON.stringify(initial))
  await open('scene=notes-fonts&fresh=1&nostore=1&static=1&quiet=1')
  await page.shot('fonts-compare', '.n-compare')

  for (const font of ['system', 'inter']) {
    await open(`scene=channel&fresh=1&nostore=1&static=1&quiet=1&font=${font}`)
    if (font === 'inter') {
      // document.fonts.check() answers true for a family that was never registered, so look at the FontFace itself.
      try {
        await page.waitFor(
          "[...document.fonts].some((f) => f.family.replace(/[\"']/g, '') === 'Inter' && f.status === 'loaded')",
          8000,
        )
      } catch {
        console.log('Inter was not loaded within 8 s')
      }
    }
    await page.sleep(400)
    const m = await ev(`(() => {
      const el = document.querySelector('.bubble--in p'); const cs = getComputedStyle(el)
      const range = document.createRange(); range.selectNodeContents(el)
      const probe = (text) => { const c = document.createElement('canvas').getContext('2d'); c.font = '15px ' + cs.fontFamily; return Math.round(c.measureText(text).width * 10) / 10 }
      return {
        dataFont: document.documentElement.getAttribute('data-font'),
        family: cs.fontFamily.slice(0, 70),
        bubbleWidth: Math.round(range.getBoundingClientRect().width),
        latin15px: probe('The quick brown fox 0123456789'),
        cjk15px: probe('今天先把侧栏和输入栏对一遍'),
        interFaces: [...document.fonts].filter((f) => f.family.replace(/["']/g, '') === 'Inter').map((f) => f.status),
      }
    })()`)
    console.log(`${font}:`, JSON.stringify(m))
    await page.shot(`fonts-channel-${font}`, '.main')
  }
} finally {
  await page.close()
}
