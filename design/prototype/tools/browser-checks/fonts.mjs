// D1 font comparison on the machine running the check: which fonts exist, and how the system stack and
// Inter render the same screen. Needs network access for Inter (Google Fonts).
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
    "[...document.querySelectorAll('.n-card')].filter(c => /有|没有/.test(c.textContent) && c.querySelector('.t-callout')).map(c => c.textContent.replace(/\\s+/g, ' ').trim())",
  )
  console.log('fonts on this device:', fonts.join(' | '))
  await page.shot('fonts-compare', '.n-compare')

  // what the stack actually resolves to for Latin and for Chinese text
  const resolved = await ev(`(() => {
    const probe = (stack, text) => { const c = document.createElement('canvas').getContext('2d'); c.font = '15px ' + stack; return Math.round(c.measureText(text).width * 10) / 10 }
    const stacks = { system: getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim() }
    return { systemLatin: probe(stacks.system, 'The quick brown fox 0123456789'), systemCjk: probe(stacks.system, '今天先把侧栏和输入栏对一遍') }
  })()`)
  console.log('system stack widths at 15px:', JSON.stringify(resolved))

  for (const font of ['system', 'inter']) {
    await open(`scene=channel&fresh=1&nostore=1&static=1&quiet=1&font=${font}`)
    if (font === 'inter') {
      try {
        await page.waitFor("document.fonts.check('15px Inter')", 8000)
      } catch {
        console.log('Inter did not load within 8 s (no network?)')
      }
    }
    await page.sleep(400)
    const m = await ev(`(() => {
      const el = document.querySelector('.bubble--in p'); const cs = getComputedStyle(el)
      const range = document.createRange(); range.selectNodeContents(el)
      return { family: cs.fontFamily.slice(0, 60), width: Math.round(range.getBoundingClientRect().width), interLoaded: document.fonts.check('15px Inter') }
    })()`)
    console.log(`${font}:`, JSON.stringify(m))
    await page.shot(`fonts-channel-${font}`, '.main')
  }
} finally {
  await page.close()
}
