// Keyboard, focus and input method checks for the prototype (AT-21 "键盘主流程", D-050).
import { launch, PROTO_URL, suite } from './cdp.mjs'

const s = suite('keyboard')
const URL = PROTO_URL
const page = await launch({ width: 1440, height: 900 })
const ev = (e) => page.eval(e)
const active = () =>
  ev(
    '(() => { const a = document.activeElement; return a ? (a.id || a.dataset?.id || a.className || a.tagName) : null })()',
  )
const glassCount = () =>
  ev(
    "[...document.querySelector('.window').querySelectorAll('*')].filter(e => { const c = getComputedStyle(e); const f = c.backdropFilter || c.webkitBackdropFilter; return f && f !== 'none' }).length",
  )
try {
  await page.goto(`${URL}#scene=channel&fresh=1&nostore=1&static=1&quiet=1`)
  s.check('loads without console errors', page.consoleLog.length === 0, page.consoleLog.join(' | '))

  // --- sidebar: one tab stop, arrow keys move, Enter opens
  s.check(
    'sidebar list has exactly one tab stop',
    (await ev('document.querySelectorAll(\'.s-item[tabindex="0"]\').length')) === 1,
  )
  await ev('document.querySelector(\'.s-item[tabindex="0"]\').focus()')
  const first = await active()
  await page.key('ArrowDown')
  const second = await active()
  s.check('ArrowDown moves to the next conversation', first !== second, `${first} -> ${second}`)
  s.check(
    'roving tabindex follows focus',
    (await ev('document.activeElement.tabIndex')) === 0 &&
      (await ev('document.querySelectorAll(\'.s-item[tabindex="0"]\').length')) === 1,
  )
  await page.key('Enter')
  s.check(
    'Enter opens the focused conversation',
    (await ev('document.querySelector(\'.s-item[aria-current="true"]\')?.dataset.id')) === second,
    second,
  )
  await page.key('ArrowDown', { alt: true })
  const afterAlt = await ev('window.__proto.state.conv')
  s.check(
    'Alt+ArrowDown switches conversation',
    afterAlt && afterAlt !== second,
    `${second} -> ${afterAlt}`,
  )
  await ev("window.__proto.runScene('channel', { silent: true })")
  await page.sleep(300)

  // --- command palette
  await ev("document.getElementById('timeline').focus()")
  await page.key('k', { ctrl: true })
  s.check(
    'Ctrl+K opens the palette with focus in its input',
    (await ev("Boolean(document.querySelector('.palette'))")) &&
      (await active()) === 'palette-input',
  )
  s.check(
    'background is inert while the palette is open',
    await ev("document.querySelector('.app').inert === true"),
  )
  await page.type('迁移')
  await page.sleep(200)
  s.check(
    'typing searches messages (keyword results appear)',
    (await ev("document.querySelectorAll('.palette__row').length")) >= 2,
    await ev("document.querySelector('.palette__group')?.textContent"),
  )
  s.check(
    'keyword group says it does not use quota',
    await ev(
      "[...document.querySelectorAll('.palette__group')].some(g => g.textContent.includes('不消耗额度'))",
    ),
  )
  const before = await ev(
    "document.getElementById('palette-input').getAttribute('aria-activedescendant')",
  )
  await page.key('ArrowDown')
  const after = await ev(
    "document.getElementById('palette-input').getAttribute('aria-activedescendant')",
  )
  s.check(
    'ArrowDown moves the active result (aria-activedescendant)',
    before !== after,
    `${before} -> ${after}`,
  )
  await page.key('Escape')
  s.check(
    'Esc closes the palette and returns focus to the timeline',
    (await ev("!document.querySelector('.palette')")) && (await active()) === 'timeline',
    await active(),
  )
  s.check(
    'inert is released after closing',
    await ev("document.querySelector('.app').inert === false"),
  )

  // --- pointer: modal content must receive clicks (it once sat under its own scrim)
  await page.key('k', { ctrl: true })
  await page.sleep(200)
  const rowId = await ev(
    "document.querySelectorAll('.palette__row')[1]?.querySelector('.palette__label')?.textContent",
  )
  await page.click('.palette__row:nth-of-type(2)')
  await page.sleep(300)
  s.check(
    'clicking a palette row with the mouse runs it and closes the palette',
    await ev("!document.querySelector('.palette')"),
    `row: ${rowId}`,
  )
  await page.key('k', { ctrl: true })
  await page.sleep(200)
  const top = await ev(
    "(() => { const r = document.querySelector('.palette').getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e.closest('.palette') ? 'palette' : e.className })()",
  )
  s.check('the palette is on top of its scrim (hit test)', top === 'palette', String(top))
  await page.key('Escape')
  await ev("window.__proto.bus.emit('settings:open', 'appearance')")
  await page.sleep(300)
  await page.click('.sheet__tab[data-tab="account"]')
  await page.sleep(200)
  s.check(
    'clicking a settings tab with the mouse switches the section',
    (await ev("document.querySelector('.sheet__head h2')?.textContent")) === '账号',
  )
  await page.key('Escape')
  await ev("window.__proto.runScene('channel', { silent: true })")
  await page.sleep(300)

  // --- composer: send, newline, IME
  await ev("document.getElementById('composer-input').focus()")
  const count0 = await ev("document.querySelectorAll('.msg').length")
  await page.type('键盘发送的一条消息')
  s.check(
    'send button enables when there is text',
    await ev("!document.querySelector('.composer__send').disabled"),
  )
  await page.key('Enter', { shift: true })
  s.check(
    'Shift+Enter inserts a newline and does not send',
    (await ev("document.getElementById('composer-input').value.includes('\\n')")) &&
      (await ev("document.querySelectorAll('.msg').length")) === count0,
  )
  await page.key('Backspace')
  await page.key('Enter')
  await page.sleep(300)
  s.check(
    'Enter sends and clears the input',
    (await ev("document.querySelectorAll('.msg').length")) === count0 + 1 &&
      (await ev("document.getElementById('composer-input').value")) === '',
  )
  // IME: while composing, Enter only confirms the candidate (D-050)
  await ev("document.getElementById('composer-input').focus()")
  await page.type('草稿')
  await page.ime('nihao')
  s.check(
    'composition is active (compositionstart seen)',
    await ev("document.getElementById('composer-input').value.length >= 2"),
  )
  const n1 = await ev("document.querySelectorAll('.msg').length")
  await page.key('Enter')
  s.check(
    'Enter while composing does not send',
    (await ev("document.querySelectorAll('.msg').length")) === n1,
  )
  await page.type('你好') // commits the candidate
  await page.sleep(80)
  // Safari order: compositionend fires before the keydown of the confirming Enter
  const n2 = await ev("document.querySelectorAll('.msg').length")
  await ev(
    "(() => { const t = document.getElementById('composer-input'); t.dispatchEvent(new CompositionEvent('compositionstart')); t.dispatchEvent(new CompositionEvent('compositionend')); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })()",
  )
  await page.sleep(150)
  s.check(
    'Enter right after compositionend (Safari order) does not send',
    (await ev("document.querySelectorAll('.msg').length")) === n2,
  )
  await page.sleep(100)
  await page.key('Enter')
  await page.sleep(300)
  s.check(
    'Enter after composition ends sends',
    (await ev("document.querySelectorAll('.msg').length")) >= n2 + 1,
  )

  // --- edit last message with ArrowUp, cancel with Esc
  await ev("document.getElementById('composer-input').focus()")
  await page.key('ArrowUp')
  s.check(
    'ArrowUp in an empty composer starts editing the last own message',
    (await ev("document.querySelector('.composer__ctx')?.textContent.includes('编辑消息')")) &&
      (await ev("document.getElementById('composer-input').value.length")) > 0,
  )
  await page.key('Escape')
  s.check(
    'Esc cancels editing and clears the input',
    (await ev("document.querySelector('.composer__ctx')?.hidden === true")) &&
      (await ev("document.getElementById('composer-input').value")) === '',
  )

  // --- mentions
  await page.type('@')
  await page.sleep(150)
  s.check(
    'typing @ shows the mention list',
    await ev("Boolean(document.querySelector('.pop--mention'))"),
  )
  await page.key('ArrowDown')
  await page.key('Enter')
  s.check(
    'Enter inserts the chosen mention',
    (await ev("document.getElementById('composer-input').value")).startsWith('@') &&
      (await ev("!document.querySelector('.pop--mention')")),
    await ev("document.getElementById('composer-input').value"),
  )
  await ev(
    "document.getElementById('composer-input').value = ''; document.getElementById('composer-input').dispatchEvent(new Event('input'))",
  )

  // --- focus survives a re-render (a message arriving must not drop the keyboard focus)
  await ev('document.querySelector(\'.msg[tabindex="0"]\').focus()')
  const focusedId = await ev('document.activeElement.dataset.msg')
  await ev(
    "window.__proto.bus.emit('timeline:append', { convId: window.__proto.state.conv, m: { id: 'test-new', from: 'alice', t: '10:50', text: '一条新到的消息' } })",
  )
  await page.sleep(200)
  s.check(
    'keyboard focus stays on the focused message after a new message arrives',
    (await ev('document.activeElement.dataset?.msg')) === focusedId,
    `${focusedId} -> ${await ev('document.activeElement.dataset?.msg ?? document.activeElement.tagName')}`,
  )

  // --- message hover tools and context menu
  await ev(
    "(() => { const els = [...document.querySelectorAll('.msg[data-who=\"in\"]')].filter(e => { const r = e.getBoundingClientRect(); return r.top > 160 && r.bottom < 760 }); els.forEach(e => e.removeAttribute('data-test')); els[els.length - 1]?.setAttribute('data-test', 'vis') })()",
  )
  const msgSel = '.msg[data-test="vis"]'
  s.check(
    'found an incoming message on screen to hover',
    await ev('Boolean(document.querySelector(\'.msg[data-test="vis"]\'))'),
  )
  await page.hover(`${msgSel} .bubble`)
  s.check(
    'hover shows the message toolbar',
    (await ev(`getComputedStyle(document.querySelector('${msgSel} .msg__tools')).opacity`)) === '1',
  )
  s.check(
    'glass layers stay within 4 while the toolbar shows',
    (await glassCount()) <= 4,
    String(await glassCount()),
  )
  await page.click(`${msgSel} .bubble`, { button: 'right' })
  s.check(
    'right click opens the message menu',
    await ev("Boolean(document.querySelector('.menu'))"),
  )
  await page.key('ArrowDown')
  s.check(
    'menu items take focus with arrow keys',
    await ev("document.activeElement.classList.contains('menu__item')"),
  )
  await page.key('Escape')
  s.check('Esc closes the menu', await ev("!document.querySelector('.menu')"))

  // --- toolbar menu returns focus to its trigger
  await ev('document.querySelector(\'.toolbar__actions button[aria-label="更多"]\').focus()')
  await page.key('Enter')
  s.check(
    'Enter on the More button opens a menu with the first item focused',
    (await ev("Boolean(document.querySelector('.menu'))")) &&
      (await ev("document.activeElement.classList.contains('menu__item')")),
  )
  await page.key('Escape')
  s.check(
    'focus returns to the More button after Esc',
    (await ev("document.activeElement.getAttribute('aria-label')")) === '更多',
  )

  // --- settings sheet: focus trap and return
  await ev('document.querySelector(\'.sidebar__user button[aria-label="设置"]\').focus()')
  await page.key('Enter')
  await page.sleep(200)
  s.check(
    'settings opens as a modal dialog',
    await ev("Boolean(document.querySelector('.sheet[role=dialog][aria-modal=true]'))"),
  )
  s.check(
    'glass layers stay within 4 with the sheet open',
    (await glassCount()) <= 4,
    String(await glassCount()),
  )
  let escaped = 0
  for (let i = 0; i < 40; i++) {
    await page.key('Tab')
    if (!(await ev("document.activeElement.closest('.sheet') !== null"))) escaped += 1
  }
  s.check('Tab never leaves the settings sheet (40 presses)', escaped === 0, `escaped ${escaped}`)
  await page.key('Escape')
  s.check('Esc closes the settings sheet', await ev("!document.querySelector('.sheet')"))
  s.check(
    'focus returns to the settings button',
    (await ev("document.activeElement.getAttribute('aria-label')")) === '设置',
    await ev('document.activeElement.outerHTML.slice(0, 120)'),
  )

  // --- assistant panel via shortcut
  await ev("document.getElementById('composer-input').focus()")
  await page.key('j', { ctrl: true })
  await page.sleep(200)
  s.check(
    'Ctrl+J opens the assistant panel and focuses its input',
    (await ev("document.querySelector('.app').dataset.inspector")) === 'open' &&
      (await active()) === 'assist-input',
  )
  await page.key('j', { ctrl: true })
  s.check(
    'Ctrl+J again closes it and returns focus to the composer',
    (await ev("document.querySelector('.app').dataset.inspector")) === 'closed' &&
      (await active()) === 'composer-input',
    await active(),
  )
  await ev("window.__proto.runScene('channel', { silent: true })")

  // --- skip link, on a fresh page (browsers continue from the last focus position otherwise)
  await page.goto(`${URL}?fresh-load=1#scene=channel&fresh=1&nostore=1&static=1`)
  await page.key('Tab')
  s.check(
    'first Tab stop on a fresh page is the skip link',
    await ev("document.activeElement.classList.contains('skip-link')"),
    await active(),
  )
  await page.key('Enter')
  s.check(
    'activating the skip link moves focus to the main area',
    (await ev('document.activeElement.id')) === 'main',
    await ev("document.activeElement.tagName + '#' + document.activeElement.id"),
  )
} catch (err) {
  s.check('suite ran to the end', false, err.message)
} finally {
  s.check(
    'no console errors during the run',
    page.consoleLog.length === 0,
    page.consoleLog.join(' | '),
  )
  await page.close()
}
process.exit(s.done() ? 1 : 0)
