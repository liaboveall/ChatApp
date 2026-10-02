// Layout checks: no horizontal overflow at each width, main flows at 320 px, target sizes, 200% text size.
import { launch, PROTO_URL, suite } from './cdp.mjs'

const s = suite('layout')
const URL = PROTO_URL
const page = await launch({ width: 1440, height: 900 })
const ev = (e) => page.eval(e)
let nav = 0
const open = async (scene) => {
  await page.goto(`${URL}?n=${++nav}#scene=${scene}&fresh=1&nostore=1&static=1&quiet=1&width=fit`)
  await page.sleep(300)
}

// Elements wider than the window, outside any horizontally scrolling container.
const overflowProbe = `(() => {
  const win = document.querySelector('.window'); const wr = win.getBoundingClientRect(); const bad = []
  const scrolls = (e) => { for (let p = e.parentElement; p && p !== win; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' && p.classList.contains('att-grid')) return true } return false }
  for (const e of win.querySelectorAll('*')) { if (e.closest('.wallpaper')) continue; const r = e.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue; if (getComputedStyle(e).visibility === 'hidden') continue; if (e.closest('[hidden], .sidebar') && e.closest('.app[data-drawer="closed"]') && getComputedStyle(e.closest('.sidebar') || e).visibility === 'hidden') continue; if (r.right > wr.right + 1 || r.left < wr.left - 1) { if (!scrolls(e)) bad.push((e.className?.baseVal ?? e.className ?? e.tagName) + ':' + Math.round(r.left - wr.left) + '..' + Math.round(r.right - wr.left)) } }
  return { docScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth, winScroll: win.scrollWidth - win.clientWidth, bad: bad.slice(0, 6), count: bad.length }
})()`

try {
  const widths = [320, 360, 480, 768, 1024, 1280, 1440]
  for (const scene of ['channel', 'login', 'register', 'agent', 'notes-tokens']) {
    for (const w of widths) {
      await page.viewport(w, 900)
      await open(scene)
      const r = await ev(overflowProbe)
      s.check(
        `${scene} @${w}: no horizontal overflow`,
        r.docScroll <= 0 && r.winScroll <= 0 && r.count === 0,
        `doc ${r.docScroll}, window ${r.winScroll}, elements ${r.count} ${r.bad.join(' ')}`,
      )
    }
  }

  // 400% zoom equivalent: 320 CSS px wide, 200% text. Overflow and main flows.
  await page.viewport(320, 700)
  await open('channel')
  await ev("document.documentElement.style.fontSize = '200%'")
  await page.sleep(300)
  const r = await ev(overflowProbe)
  s.check(
    'channel @320 with 200% text: no horizontal overflow',
    r.docScroll <= 0 && r.winScroll <= 0 && r.count === 0,
    `elements ${r.count} ${r.bad.join(' ')}`,
  )
  await page.shot('layout-320-200pct')
  await ev("document.documentElement.style.fontSize = ''")

  // Main flows at 320 CSS px with real clicks
  await open('channel')
  await page.viewport(320, 700)
  await page.click('.toolbar__menu-btn')
  await page.sleep(400)
  s.check(
    '320: menu button opens the conversation drawer',
    (await ev("document.querySelector('.app').dataset.drawer")) === 'open',
  )
  await page.shot('layout-320-drawer')
  await page.click('.s-item[data-id="dm-alice"]')
  await page.sleep(300)
  s.check(
    '320: choosing a conversation closes the drawer and opens it',
    (await ev("document.querySelector('.app').dataset.drawer")) === 'closed' &&
      (await ev("document.querySelector('.toolbar__title')?.textContent.includes('Alice')")),
  )
  await page.click('#composer-input')
  await page.type('在 320 宽度发的消息')
  const n0 = await ev("document.querySelectorAll('.msg').length")
  await page.click('.composer__send')
  await page.sleep(300)
  s.check(
    '320: the composer sends a message',
    (await ev("document.querySelectorAll('.msg').length")) === n0 + 1,
  )
  await ev("window.__proto.runScene('agent', { silent: true })")
  await page.sleep(500)
  await ev("document.querySelector('.approval').scrollIntoView({ block: 'center' })")
  await page.sleep(200)
  await page.shot('layout-320-approval')
  const btn = await ev(
    "[...document.querySelectorAll('.approval .btn')].find(b => b.textContent.includes('批准'))?.getBoundingClientRect().width > 0",
  )
  s.check('320: approval buttons are reachable', btn)
  await page.click('.approval .btn--filled')
  await page.sleep(500)
  s.check(
    '320: approving works',
    (await ev("document.querySelector('.approval').dataset.state")) === 'approved',
  )

  // Login at 320
  await open('login')
  await page.viewport(320, 700)
  await page.click('#login-email')
  await page.type('mars@example.test')
  await page.click('#login-pw')
  await page.type('a-long-password')
  await page.key('Enter')
  await page.sleep(1200)
  s.check(
    '320: login form submits with Enter and shows the app',
    await ev("document.querySelector('.window').dataset.view === 'app'"),
  )

  // Target sizes (spec 7: at least 28 x 28 CSS px)
  await page.viewport(1440, 900)
  const audit = `(() => {
    const win = document.querySelector('.window'); const bad = []
    for (const e of win.querySelectorAll('button, [role=button], [role=tab], [role=radio], [role=switch], input:not([type=hidden]), select, textarea, .splitter')) {
      const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') continue
      if (e.closest('[hidden], [inert]')) continue
      const r = e.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue
      if (e.type === 'checkbox' || e.type === 'radio') { const l = e.closest('label'); if (l) { const lr = l.getBoundingClientRect(); if (lr.width >= 28 && lr.height >= 28) continue } }
      if (r.width < 27.5 || r.height < 27.5) bad.push((e.getAttribute('aria-label') || e.textContent.trim().slice(0, 12) || e.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height))
    }
    return bad
  })()`
  for (const scene of [
    'channel',
    'agent',
    'group',
    'settings-appearance',
    'settings-account',
    'settings-assistant',
    'palette',
    'notifications',
    'login',
    'register',
    'new-member',
  ]) {
    await open(scene)
    await page.sleep(500)
    const bad = await ev(audit)
    s.check(
      `${scene}: every control is at least 28 x 28`,
      bad.length === 0,
      bad.slice(0, 6).join(' | '),
    )
  }
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
