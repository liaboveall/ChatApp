/**
 * Real-process acceptance walk-through for the backend (docs/11 M1a "验收"): administrator -> invitation -> registration
 * -> verification email in Mailpit -> verification -> login -> WebSocket -> sign-out closes the connection.
 *
 * It talks to a RUNNING api and worker, so start them first, preferably against the test environment (it leaves accounts
 * behind in whatever database those processes use). The integration suite truncates the test database, bootstrap data
 * included, so bootstrap it again before starting the processes:
 *
 *   bun run db:bootstrap:test
 *   APP_ENV=test bun --env-file=.env.local apps/server/src/api.ts       # terminal 1
 *   APP_ENV=test bun --env-file=.env.local apps/server/src/worker.ts    # terminal 2
 *   printf '%s\n' "$PASSWORD" | APP_ENV=test bun --env-file=.env.local apps/server/src/cli.ts admin:create \
 *     --email smoke-admin@example.test --username smokeadmin --name "Smoke Admin"
 *   SMOKE_ADMIN_EMAIL=smoke-admin@example.test SMOKE_ADMIN_PASSWORD=$PASSWORD bun run smoke:backend
 *
 * Nothing secret is printed. Mail it creates is removed from Mailpit again.
 */
const API = process.env.SMOKE_API_URL ?? 'http://127.0.0.1:3100'
const WS = API.replace(/^http/, 'ws')
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173'
const MAILPIT = process.env.SMOKE_MAILPIT_URL ?? 'http://localhost:8025'
const adminEmail = process.env.SMOKE_ADMIN_EMAIL
const adminPassword = process.env.SMOKE_ADMIN_PASSWORD
if (!adminEmail || !adminPassword) {
  console.error(
    'set SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD (an existing administrator of the target database)',
  )
  process.exit(2)
}
const memberPassword = `Zq9-${crypto.randomUUID().slice(0, 18)}-lantern`

type Jar = Map<string, string>
const jar = (): Jar => new Map()

async function call(
  path: string,
  init: { method?: string; json?: unknown; cookies?: Jar; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('origin', ORIGIN)
  if (init.json !== undefined) headers.set('content-type', 'application/json')
  if (init.cookies?.size)
    headers.set('cookie', [...init.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
  const response = await fetch(API + path, {
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  })
  for (const line of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = line.split(';').map((part) => part.trim())
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    if (attributes.some((a) => /^max-age=0$/i.test(a)) || value === '') init.cookies?.delete(name)
    else init.cookies?.set(name, value)
  }
  return response
}

let failed = false
function step(n: number, text: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${n}. ${text}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failed = true
}

const admin = jar()
const login = await call('/api/auth/sign-in/email', {
  json: { email: adminEmail, password: adminPassword },
  cookies: admin,
})
step(
  1,
  'administrator signs in (cookie only, no token in the body)',
  login.status === 200 && !JSON.stringify(await login.clone().json()).includes('token'),
  `HTTP ${login.status}`,
)
const invite = (await (
  await call('/api/invites', { json: { note: 'smoke' }, cookies: admin })
).json()) as { code?: string }
step(
  2,
  'administrator creates an invitation code',
  /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/.test(invite.code ?? ''),
)

const stamp = Date.now()
const email = `member-${stamp}@example.test`
const form = {
  email,
  username: `m${stamp % 1_000_000_000}`,
  name: 'Smoke Member',
  password: memberPassword,
}
const noCode = await call('/api/auth/sign-up/email', {
  json: form,
  headers: { 'idempotency-key': `smoke-${stamp}` },
})
const withCode = await call('/api/auth/sign-up/email', {
  json: form,
  headers: { 'x-invite-code': invite.code ?? '', 'idempotency-key': `smoke-${stamp}` },
})
step(
  3,
  'registration fails without a code and succeeds with one',
  noCode.status === 400 && withCode.status === 200,
  `${noCode.status}/${withCode.status}`,
)

let text = ''
for (let i = 0; i < 40 && !text; i += 1) {
  await Bun.sleep(500)
  const found = (await (
    await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json()) as { messages?: Array<{ ID: string }> }
  const id = found.messages?.[0]?.ID
  if (id)
    text = ((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string })
      .Text
}
const token = /\/verify-email#token=([A-Za-z0-9_-]{43})/.exec(text)?.[1]
step(
  4,
  'the worker delivers the verification email; the token is in the URL fragment',
  Boolean(token) && !text.includes('?token='),
)
const early = await call('/api/auth/sign-in/email', { json: { email, password: memberPassword } })
step(
  5,
  'login is refused until the email is verified',
  early.status === 403,
  `HTTP ${early.status}`,
)
const preview = await call(`/api/auth/verification/consume?token=${token}`)
const consumed = await call('/api/auth/verification/consume', { json: { token } })
step(
  6,
  'the link is consumed only by an explicit POST (a GET is a 404)',
  preview.status === 404 && consumed.status === 200,
  `${preview.status}/${consumed.status}`,
)

const member = jar()
const memberLogin = await call('/api/auth/sign-in/email', {
  json: { email, password: memberPassword },
  cookies: member,
})
step(7, 'the new member signs in', memberLogin.status === 200)
const cookie = [...member].map(([k, v]) => `${k}=${v}`).join('; ')
const events: string[] = []
let closeCode = 0
let closedAt = 0
const socket = new WebSocket(`${WS}/ws`, { headers: { origin: ORIGIN, cookie } } as never)
await new Promise<void>((resolve) => {
  socket.onmessage = (event) => {
    events.push(String(event.data))
    if (events.length === 1) resolve()
  }
})
const hello = JSON.parse(events[0] ?? '{}') as { type?: string; data?: { heartbeatMs?: number } }
step(
  8,
  'WebSocket connects and greets with hello (server time, heartbeat)',
  hello.type === 'hello' && hello.data?.heartbeatMs === 25_000,
)
socket.send(JSON.stringify({ v: 1, type: 'ping', data: {} }))
await Bun.sleep(300)
step(
  9,
  'ping is answered with pong',
  events.some((e) => (JSON.parse(e) as { type?: string }).type === 'pong'),
)
socket.onclose = (event) => {
  closeCode = event.code
  closedAt = Date.now()
}

const signedOutAt = Date.now()
const out = await call('/api/auth/sign-out', { method: 'POST', cookies: member })
for (let i = 0; i < 80 && !closedAt; i += 1) await Bun.sleep(100)
step(
  10,
  'signing out closes the WebSocket with 4401 (within the 5 s recheck)',
  out.status === 200 && closeCode === 4401 && closedAt - signedOutAt <= 6000,
  `closed after ${closedAt ? closedAt - signedOutAt : 'never'} ms`,
)

const closeOf = (headers: Record<string, string>) =>
  new Promise<number>((resolve) => {
    const s = new WebSocket(`${WS}/ws`, { headers } as never)
    s.onclose = (event) => resolve(event.code)
  })
const foreign = await closeOf({ origin: 'http://evil.example', cookie })
const anonymous = await closeOf({ origin: ORIGIN })
step(
  11,
  'a foreign origin closes with 4403, no session with 4401',
  foreign === 4403 && anonymous === 4401,
  `${foreign}/${anonymous}`,
)

await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`, {
  method: 'DELETE',
}).catch(() => undefined)
console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE PASSED')
process.exit(failed ? 1 : 0)
