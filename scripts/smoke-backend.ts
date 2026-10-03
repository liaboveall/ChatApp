/**
 * Real-process acceptance walk-through for the backend.
 *
 * M1a (docs/11 "验收"): administrator -> invitation -> registration -> verification email in Mailpit -> verification ->
 * login -> WebSocket -> sign-out closes the connection.
 * M2a: two more members; a channel with a Chinese name; browsing and joining; a message reaching the other member as a
 * content-free hint within a second of the request (the api and the worker are separate processes, the hint travels
 * through Postgres and Valkey); reading, unread counts and the read position; typing; presence; edit, recall and the
 * changes feed; what a stranger and a site administrator may and may not do; removal ending the stream at once.
 *
 * It talks to a RUNNING api and worker, so start them first, preferably against the test environment (it leaves accounts
 * and conversations behind in whatever database those processes use). The integration suite truncates the test
 * database, bootstrap data included, so bootstrap it again before starting the processes:
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

/** The text of the mail Mailpit received for an address, waiting up to 20 s for the worker to deliver it. */
async function waitForMail(address: string): Promise<string> {
  for (let i = 0; i < 40; i += 1) {
    await Bun.sleep(500)
    const found = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)
    ).json()) as { messages?: Array<{ ID: string }> }
    const id = found.messages?.[0]?.ID
    if (id) {
      return ((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string })
        .Text
    }
  }
  return ''
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

const text = await waitForMail(email)
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

// ───────── M2a: conversations, messages and realtime hints ─────────

type Member = { jar: Jar; cookie: string; id: string; address: string }
type Frame = { type: string; data: Record<string, unknown>; at: number }
type Sent = { message: { id: string; seq: number; changeSeq: number; body: string | null } }
type Listed = {
  messages: Array<{
    id: string
    body: string | null
    editedAt: string | null
    recalledAt: string | null
    deletedAt: string | null
  }>
}
type ConversationView = {
  id: string
  name: string | null
  kind: string
  me: { unread: number; role: string } | null
}

const addresses = [email]

/** Registers and signs in one more member through the real endpoints (invitation, email, verification). */
async function newMember(label: string): Promise<Member> {
  const invitation = (await (
    await call('/api/invites', { json: { note: `smoke ${label}` }, cookies: admin })
  ).json()) as { code?: string }
  const at = Date.now()
  const address = `${label}-${at}@example.test`
  addresses.push(address)
  const signUp = await call('/api/auth/sign-up/email', {
    json: {
      email: address,
      username: `${label}${at % 1_000_000_000}`,
      name: `Smoke ${label.toUpperCase()}`,
      password: memberPassword,
    },
    headers: { 'x-invite-code': invitation.code ?? '', 'idempotency-key': `smoke-${label}-${at}` },
  })
  const mail = await waitForMail(address)
  const mailed = /\/verify-email#token=([A-Za-z0-9_-]{43})/.exec(mail)?.[1]
  const verified = await call('/api/auth/verification/consume', { json: { token: mailed } })
  const cookies = jar()
  const signIn = await call('/api/auth/sign-in/email', {
    json: { email: address, password: memberPassword },
    cookies,
  })
  const me = (await (await call('/api/me', { cookies })).json()) as { id?: string }
  if (signUp.status !== 200 || verified.status !== 200 || signIn.status !== 200 || !me.id) {
    throw new Error(
      `could not create member ${label}: ${signUp.status}/${verified.status}/${signIn.status}`,
    )
  }
  return {
    jar: cookies,
    cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    id: me.id,
    address,
  }
}

function openSocket(person: Member) {
  const events: Frame[] = []
  const ws = new WebSocket(`${WS}/ws`, {
    headers: { origin: ORIGIN, cookie: person.cookie },
  } as never)
  ws.onmessage = (event) => {
    events.push({ ...(JSON.parse(String(event.data)) as Omit<Frame, 'at'>), at: Date.now() })
  }
  return {
    events,
    send: (type: string, data: unknown) => ws.send(JSON.stringify({ v: 1, type, data })),
    close: () => ws.close(),
    /** The first event of this type that satisfies the test, waiting up to `ms`; undefined when none comes. */
    async waitFor(
      type: string,
      match: (data: Record<string, unknown>) => boolean = () => true,
      ms = 4000,
    ) {
      const until = Date.now() + ms
      for (;;) {
        const found = events.find((e) => e.type === type && match(e.data))
        if (found || Date.now() > until) return found
        await Bun.sleep(15)
      }
    },
  }
}

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0

const memberB = await newMember('b')
const memberC = await newMember('c')
step(12, 'two more members register (invitation, email, verification) and sign in', true)

const socketB = openSocket(memberB)
await socketB.waitFor('hello')

const channelName = `烟雾测试${stamp % 100_000}`
const createKey = crypto.randomUUID()
const createChannel = () =>
  call('/api/conversations', {
    json: { kind: 'channel', name: channelName },
    cookies: memberB.jar,
    headers: { 'idempotency-key': createKey },
  })
const created = await createChannel()
const channel = await readJson<ConversationView>(created)
const replay = await readJson<ConversationView>(await createChannel())
step(
  13,
  'B creates a channel with a Chinese name; the same Idempotency-Key gives the same channel again',
  created.status === 201 &&
    channel.name === channelName &&
    channel.me?.role === 'owner' &&
    replay.id === channel.id,
  `HTTP ${created.status}`,
)

const browsed = await readJson<{ items: ConversationView[] }>(
  await call(`/api/channels?query=${encodeURIComponent(channelName)}`, { cookies: memberC.jar }),
)
const found = browsed.items.find((item) => item.id === channel.id)
const joined = await call(`/api/conversations/${channel.id}/join`, {
  method: 'POST',
  cookies: memberC.jar,
})
step(
  14,
  'C finds the channel by browsing (not a member yet) and joins it',
  found !== undefined && found.me === null && joined.status === 200,
  `HTTP ${joined.status}`,
)

const socketC = openSocket(memberC)
await socketC.waitFor('hello')
const spoken = '你好，烟雾测试'
const startedAt = Date.now()
const send = await call(`/api/conversations/${channel.id}/messages`, {
  json: { clientId: crypto.randomUUID(), body: spoken },
  cookies: memberB.jar,
})
const first = await readJson<Sent>(send)
const hint = await socketC.waitFor('message.changed', (d) => d.messageId === first.message?.id)
step(
  15,
  'a message from B reaches C as a hint with ids and versions only, no content, across api, worker and Valkey',
  send.status === 201 &&
    hint !== undefined &&
    hint.data.conversationId === channel.id &&
    !JSON.stringify(hint).includes('烟雾'),
  hint ? `${hint.at - startedAt} ms after the request began` : 'no hint within 4 s',
)

const seen = await readJson<Listed>(
  await call(`/api/conversations/${channel.id}/messages`, { cookies: memberC.jar }),
)
const unread = async () =>
  (
    await readJson<{ conversations: ConversationView[] }>(
      await call('/api/conversations', { cookies: memberC.jar }),
    )
  ).conversations.find((item) => item.id === channel.id)?.me?.unread
const unreadBefore = await unread()
const read = await call(`/api/conversations/${channel.id}/read`, {
  json: { seq: first.message.seq },
  cookies: memberC.jar,
})
const unreadAfter = await unread()
step(
  16,
  'C reads the message over HTTP, has one unread, and none after reporting it read',
  seen.messages[0]?.body === spoken &&
    unreadBefore === 1 &&
    read.status === 200 &&
    unreadAfter === 0,
  `unread ${unreadBefore} -> ${unreadAfter}`,
)

socketC.send('typing', { conversationId: channel.id, state: 'start' })
const typing = await socketB.waitFor('typing', (d) => d.userId === memberC.id)
socketB.send('presence.watch', { userIds: [memberC.id] })
const snapshot = await socketB.waitFor('presence.snapshot')
const entries = (snapshot?.data.users ?? []) as Array<{ userId: string; status: string }>
step(
  17,
  'C’s typing reaches B; B’s presence snapshot shows C online',
  typing !== undefined && entries.find((e) => e.userId === memberC.id)?.status === 'online',
)

const edited = await call(`/api/messages/${first.message.id}`, {
  method: 'PATCH',
  json: { body: `${spoken}（已编辑）`, expectedChangeSeq: first.message.changeSeq },
  cookies: memberB.jar,
})
const editHint = await socketC.waitFor(
  'message.changed',
  (d) => d.messageId === first.message.id && Number(d.changeSeq) > first.message.changeSeq,
)
const feed = await readJson<{
  items: Array<{ id: string; editedAt: string | null }>
  resetRequired: boolean
}>(
  await call(`/api/conversations/${channel.id}/changes?after=${first.message.changeSeq}`, {
    cookies: memberC.jar,
  }),
)
const recalled = await call(`/api/messages/${first.message.id}/recall`, {
  method: 'POST',
  cookies: memberB.jar,
})
const afterRecall = await readJson<Listed>(
  await call(`/api/conversations/${channel.id}/messages`, { cookies: memberC.jar }),
)
step(
  18,
  'an edit reaches C as a hint and in the changes feed; a recall clears the body for everyone',
  edited.status === 200 &&
    editHint !== undefined &&
    feed.resetRequired === false &&
    feed.items.some((item) => item.id === first.message.id && item.editedAt !== null) &&
    recalled.status === 200 &&
    afterRecall.messages[0]?.recalledAt != null &&
    afterRecall.messages[0]?.body === null,
)

const group = await readJson<ConversationView>(
  await call('/api/conversations', {
    json: { kind: 'group', name: `烟雾群${stamp % 100_000}` },
    cookies: memberB.jar,
    headers: { 'idempotency-key': crypto.randomUUID() },
  }),
)
const strangerSees = await call(`/api/conversations/${group.id}`, { cookies: memberC.jar })
const adminReads = await call(`/api/conversations/${channel.id}/messages`, { cookies: admin })
const second = await readJson<Sent>(
  await call(`/api/conversations/${channel.id}/messages`, {
    json: { clientId: crypto.randomUUID(), body: 'to be removed by a moderator' },
    cookies: memberB.jar,
  }),
)
const moderated = await call(`/api/messages/${second.message.id}`, {
  method: 'DELETE',
  cookies: admin,
})
const afterDelete = await readJson<Listed>(
  await call(`/api/conversations/${channel.id}/messages`, { cookies: memberC.jar }),
)
step(
  19,
  'a private group is a 404 to a stranger; a site administrator may delete a message but not read the channel',
  strangerSees.status === 404 &&
    adminReads.status === 403 &&
    moderated.status < 300 &&
    afterDelete.messages.find((m) => m.id === second.message.id)?.deletedAt != null,
  `${strangerSees.status}/${adminReads.status}/${moderated.status}`,
)

const lagging: number[] = []
for (let i = 0; i < 5; i += 1) {
  const t0 = Date.now()
  const sentNow = await readJson<Sent>(
    await call(`/api/conversations/${channel.id}/messages`, {
      json: { clientId: crypto.randomUUID(), body: `latency ${i}` },
      cookies: memberB.jar,
    }),
  )
  const got = await socketC.waitFor(
    'message.changed',
    (d) => d.messageId === sentNow.message?.id,
    3000,
  )
  lagging.push(got ? got.at - t0 : 3000)
  await Bun.sleep(250)
}
step(
  20,
  'five messages in a row each reach C within a second of the request (local, informational)',
  Math.max(...lagging) < 1000,
  `median ${median(lagging)} ms, worst ${Math.max(...lagging)} ms`,
)

const removed = await call(`/api/conversations/${channel.id}/members/${memberC.id}`, {
  method: 'DELETE',
  cookies: memberB.jar,
})
const told = await socketC.waitFor('conversation.removed', (d) => d.conversationId === channel.id)
const heardBefore = socketC.events.length
await call(`/api/conversations/${channel.id}/messages`, {
  json: { clientId: crypto.randomUUID(), body: 'C should not hear this' },
  cookies: memberB.jar,
})
await Bun.sleep(1500)
const leaked = socketC.events
  .slice(heardBefore)
  .some((e) => e.type === 'message.changed' && e.data.conversationId === channel.id)
const afterRemoval = await call(`/api/conversations/${channel.id}/messages`, {
  cookies: memberC.jar,
})
step(
  21,
  'after C is removed they are told once, hear nothing more about the channel, and can no longer read it',
  removed.status < 300 && told !== undefined && !leaked && afterRemoval.status === 403,
  `${removed.status}/${afterRemoval.status}${leaked ? ', STILL HEARD' : ''}`,
)

socketC.close()
const offline = await socketB.waitFor(
  'presence',
  (d) => d.userId === memberC.id && d.status === 'offline',
)
step(
  22,
  'when C closes the connection B is told C is offline, with a last-seen time',
  offline !== undefined && typeof offline.data.lastSeenAt === 'string',
)
socketB.close()

for (const address of addresses) {
  await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`, {
    method: 'DELETE',
  }).catch(() => undefined)
}
console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE PASSED')
process.exit(failed ? 1 : 0)
