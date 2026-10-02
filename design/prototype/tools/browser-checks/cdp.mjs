// Minimal Chrome DevTools Protocol driver for headless Edge, run with the Windows node.exe (WSL cannot
// reach a Windows localhost port). The debugging port is bound to 127.0.0.1 only (Edge's default) and is
// chosen by Edge itself. Paths come from the environment; run.sh sets them.
//   EDGE_PATH    msedge.exe (default: the usual Program Files location)
//   CHECK_ROOT   scratch directory for profiles and screenshots (default: %TEMP%\\chatapp-d)
//   PROTO_URL    where the built prototype is served (default: http://127.0.0.1:8790/index.html)
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EDGE =
  process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const ROOT = process.env.CHECK_ROOT ?? join(process.env.TEMP ?? 'C:\\Temp', 'chatapp-d')
export const PROTO_URL = process.env.PROTO_URL ?? 'http://127.0.0.1:8790/index.html'
export const SHOTS = join(ROOT, 'shots')
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const KEYS = {
  Enter: ['Enter', 13],
  Escape: ['Escape', 27],
  Tab: ['Tab', 9],
  Backspace: ['Backspace', 8],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36],
  End: ['End', 35],
  ' ': ['Space', 32],
}

export async function launch({ width = 1440, height = 900, scale = 1 } = {}) {
  const profile = join(ROOT, `profile-cdp-${Date.now()}`)
  mkdirSync(profile, { recursive: true })
  const proc = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--disable-sync',
      '--disable-extensions',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  let port, path
  for (let i = 0; i < 100; i++) {
    const f = join(profile, 'DevToolsActivePort')
    if (existsSync(f)) {
      const [p, w] = readFileSync(f, 'utf8').trim().split(/\r?\n/)
      if (p && w) {
        port = p
        path = w
        break
      }
    }
    await sleep(100)
  }
  if (!port) throw new Error('Edge did not report a debugging port')
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  const listeners = []
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result)
    } else if (msg.method) for (const l of listeners) l(msg)
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const myId = ++id
      pending.set(myId, { res, rej })
      ws.send(JSON.stringify({ id: myId, method, params, sessionId }))
    })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const cmd = (method, params) => send(method, params, sessionId)
  await cmd('Page.enable')
  await cmd('Runtime.enable')
  await cmd('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false,
  })
  const consoleLog = []
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return
    if (m.method === 'Runtime.exceptionThrown')
      consoleLog.push(
        `EXC ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`,
      )
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
      consoleLog.push(
        `${m.params.type.toUpperCase()} ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`,
      )
  })

  const page = {
    consoleLog,
    cmd,
    async goto(url) {
      const loaded = new Promise((res) => {
        const l = (m) => {
          if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') {
            listeners.splice(listeners.indexOf(l), 1)
            res()
          }
        }
        listeners.push(l)
      })
      await cmd('Page.navigate', { url })
      await Promise.race([
        loaded,
        sleep(6000).then(() => {
          throw new Error(`goto timed out (same-document navigation?): ${url}`)
        }),
      ])
      await page.waitFor("document.documentElement.dataset.ready === 'true'", 8000)
      await sleep(250)
    },
    async eval(expression) {
      const r = await cmd('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      if (r.exceptionDetails)
        throw new Error(
          `eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression.slice(0, 200)}`,
        )
      return r.result.value
    },
    async waitFor(expression, timeout = 3000) {
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        if (await page.eval(`Boolean(${expression})`)) return true
        await sleep(50)
      }
      throw new Error(`timeout waiting for: ${expression}`)
    },
    async shot(name, clipSel) {
      let clip
      if (clipSel) {
        const r = await page.rect(clipSel)
        if (r) clip = { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }
      }
      const { data } = await cmd('Page.captureScreenshot', {
        format: 'png',
        ...(clip ? { clip } : {}),
      })
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
    },
    async rect(sel) {
      return page.eval(
        `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } })()`,
      )
    },
    async viewport(w, h, dpr = 1) {
      await cmd('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: dpr,
        mobile: false,
      })
      await sleep(150)
    },
    async media(features) {
      await cmd('Emulation.setEmulatedMedia', {
        features: Object.entries(features).map(([name, value]) => ({ name, value })),
      })
    },
    async key(key, mods = {}) {
      const mask =
        (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0)
      const [code, vk] =
        KEYS[key] ??
        (key.length === 1
          ? [
              /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`,
              key.toUpperCase().charCodeAt(0),
            ]
          : [key, 0])
      const printable = key.length === 1 && !mods.ctrl && !mods.alt && !mods.meta
      // Enter and Space activate buttons only when the key event carries text, like a real keypress.
      const text = key === 'Enter' ? '\r' : printable ? key : undefined
      await cmd('Input.dispatchKeyEvent', {
        type: text ? 'keyDown' : 'rawKeyDown',
        key,
        code,
        windowsVirtualKeyCode: vk,
        modifiers: mask,
        text,
      })
      await cmd('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: vk,
        modifiers: mask,
      })
      await sleep(60)
    },
    async type(text) {
      await cmd('Input.insertText', { text })
      await sleep(60)
    },
    async ime(text) {
      await cmd('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      })
      await sleep(60)
    },
    async click(sel, { button = 'left' } = {}) {
      const r = await page.rect(sel)
      if (!r) throw new Error(`click: no element ${sel}`)
      const x = r.x + r.width / 2,
        y = r.y + r.height / 2
      await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      await cmd('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        clickCount: 1,
        buttons: 1,
      })
      await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
      await sleep(80)
    },
    async hover(sel) {
      const r = await page.rect(sel)
      if (!r) throw new Error(`hover: no element ${sel}`)
      await cmd('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
      })
      await sleep(120)
    },
    sleep,
    async close() {
      try {
        await send('Browser.close')
      } catch {}
      try {
        ws.close()
      } catch {}
      proc.kill()
      await sleep(300)
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch {}
    },
  }
  return page
}

export function suite(name) {
  const results = []
  return {
    check(label, ok, detail = '') {
      results.push({ label, ok: Boolean(ok), detail: String(detail) })
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`)
    },
    done() {
      const failed = results.filter((r) => !r.ok)
      console.log(`\n${name}: ${results.length - failed.length}/${results.length} passed`)
      return failed.length
    },
    results,
  }
}
