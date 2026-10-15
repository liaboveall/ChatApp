import { check } from 'k6'
import { randomBytes } from 'k6/crypto'
import exec from 'k6/execution'
import http from 'k6/http'
import { Counter, Rate, Trend } from 'k6/metrics'
import ws from 'k6/ws'

const fixture = JSON.parse(open('/run/chatapp-load/fixture.json'))
const mode = __ENV.CHATAPP_LOAD_PROFILE || 'smoke'
const distribution = __ENV.CHATAPP_LOAD_DISTRIBUTION || 'normal'
const clientMatrix = __ENV.CHATAPP_LOAD_CLIENT_MATRIX === 'true'
if (!['normal', 'hot'].includes(distribution))
  throw new Error('explicit load distribution required')
if (
  !['smoke', 'full'].includes(mode) ||
  fixture.format !== 1 ||
  !/^https:\/\//.test(fixture.origin)
)
  throw new Error('verified HTTPS benchmark fixture required')
if (
  mode === 'full' &&
  (fixture.profile !== 'full' ||
    fixture.dataset.users < 1000 ||
    fixture.dataset.messages < 1000000 ||
    fixture.dataset.conversations < 200 ||
    fixture.dataset.objects < 100000 ||
    fixture.dataset.objectBytes < 10000000000 ||
    fixture.users.length < 500)
)
  throw new Error('full dataset and authenticated users required')
if (
  distribution === 'normal' &&
  fixture.users.some(
    (user) =>
      !user.targets || ['small', 'medium', 'large'].some((tier) => !user.targets[tier]?.length),
  )
)
  throw new Error('authorized small, medium and large targets required')
if (distribution === 'hot' && !fixture.hotConversationId)
  throw new Error('hot-channel fixture required')
const receivers = Number(__ENV.CHATAPP_LOAD_FAST_CONNECTIONS || (mode === 'full' ? 500 : 4)),
  active = mode === 'full' ? 200 : 4,
  seconds = mode === 'full' ? 2100 : 30
const delivery = new Trend('authorized_delivery_ms'),
  deliverySamples = new Counter('authorized_delivery_samples'),
  permissionErrors = new Counter('permission_errors'),
  duplicateEffects = new Counter('duplicate_effects')
const unexpected = new Rate('unexpected_errors'),
  hello = new Rate('authorized_ws_hello')
const sends = {
  small: new Counter('small_sends'),
  medium: new Counter('medium_sends'),
  large: new Counter('large_sends'),
  hot: new Counter('hot_sends'),
}
const reconnected = new Counter('reconnect_attempts'),
  messageAttempts = new Counter('message_attempts'),
  boundaryIterations = new Counter('scheduler_boundary_iterations'),
  backpressure = new Counter('expected_backpressure')
export const options = {
  summaryTrendStats: ['min', 'avg', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    receive: {
      executor: 'per-vu-iterations',
      vus: receivers,
      iterations: 1,
      exec: 'receive',
      maxDuration: `${seconds + 15}s`,
    },
    send: {
      executor: 'constant-arrival-rate',
      startTime: '2s',
      rate: mode === 'full' ? 20 : 1,
      timeUnit: '1s',
      duration: `${seconds}s`,
      preAllocatedVUs: mode === 'full' ? 40 : 8,
      maxVUs: mode === 'full' ? 80 : 16,
      exec: 'send',
    },
    ...(clientMatrix
      ? {
          reconnect: {
            executor: 'constant-arrival-rate',
            rate: mode === 'full' ? 100 : 4,
            timeUnit: '1s',
            startTime: mode === 'full' ? '302s' : '17s',
            duration: mode === 'full' ? '5s' : '1s',
            preAllocatedVUs: mode === 'full' ? 220 : 8,
            maxVUs: mode === 'full' ? 300 : 8,
            exec: 'reconnect',
          },
        }
      : {}),
  },
  thresholds: {
    ...(distribution === 'normal'
      ? { authorized_delivery_ms: [mode === 'full' ? 'p(95)<300' : 'p(95)<200'] }
      : {}),
    authorized_delivery_samples: ['count>0'],
    unexpected_errors: ['rate<0.01'],
    permission_errors: ['count==0'],
    duplicate_effects: ['count==0'],
    authorized_ws_hello: ['rate==1'],
    dropped_iterations: ['count==0'],
    message_attempts: [mode === 'full' ? 'count==42000' : 'count==30'],
    ...(clientMatrix ? { reconnect_attempts: [mode === 'full' ? 'count==500' : 'count==4'] } : {}),
    ...(distribution === 'normal'
      ? { small_sends: ['count>0'], medium_sends: ['count>0'], large_sends: ['count>0'] }
      : { hot_sends: ['count>0'] }),
  },
  // Omit URL/user/session/resource labels from all metrics. Payloads and request headers are never logged.
  systemTags: ['status', 'method', 'name', 'scenario'],
  discardResponseBodies: true,
}
function uuid() {
  const bytes = new Uint8Array(randomBytes(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function account() {
  return fixture.users[exec.scenario.iterationInTest % fixture.users.length]
}
function params(user, name) {
  return {
    headers: { Cookie: user.cookie, Origin: fixture.origin, 'Content-Type': 'application/json' },
    tags: { name },
    redirects: 0,
    responseType: 'text',
    timeout: '10s',
  }
}
export function send() {
  const index = exec.scenario.iterationInTest
  // A boundary scheduler tick must not add traffic beyond the specified fixed-rate window.
  if (index >= seconds * (mode === 'full' ? 20 : 1)) {
    boundaryIterations.add(1)
    return
  }
  const user = fixture.users[index % Math.min(active, fixture.users.length)],
    tier =
      distribution === 'hot'
        ? 'hot'
        : index % 20 < 16
          ? 'small'
          : index % 20 < 19
            ? 'medium'
            : 'large',
    targets = tier === 'hot' ? [fixture.hotConversationId] : user.targets[tier],
    conversationId = targets[Math.floor(index / active) % targets.length],
    clientId = uuid(),
    startedAt = Date.now()
  const result = http.post(
    `${fixture.origin}/api/conversations/${conversationId}/messages`,
    JSON.stringify({ clientId, body: `benchmark-delivery:${startedAt}:${clientId}` }),
    params(user, 'message.send'),
  )
  const ok = check(result, { 'message accepted': result.status === 201 })
  const pressured = distribution === 'hot' && [429, 503].includes(result.status)
  backpressure.add(pressured ? 1 : 0)
  sends[tier].add(1)
  messageAttempts.add(1)
  permissionErrors.add(0)
  duplicateEffects.add(0)
  unexpected.add(!ok && !pressured)
  deliverySamples.add(0)
  if ([401, 403, 404].includes(result.status)) permissionErrors.add(1)
  if (ok && exec.scenario.iterationInTest % 100 === 0) {
    const repeat = http.post(
      `${fixture.origin}/api/conversations/${conversationId}/messages`,
      JSON.stringify({ clientId, body: `benchmark-delivery:${startedAt}:${clientId}` }),
      params(user, 'message.idempotent-replay'),
    )
    const first = result.json().message,
      second = repeat.json().message
    duplicateEffects.add(
      repeat.status !== 200 || !first?.id || !second?.id || second.id !== first.id ? 1 : 0,
    )
  }
}
export function receive() {
  const user = account(),
    seen = new Set()
  let greeted = false,
    plannedClose = false
  const result = ws.connect(
    `${fixture.origin.replace(/^https:/, 'wss:')}/ws`,
    params(user, 'ws.connect'),
    (socket) => {
      socket.on('message', (text) => {
        let event
        try {
          event = JSON.parse(text)
        } catch {
          unexpected.add(true)
          return
        }
        if (event.type === 'hello') {
          greeted = event.data.userId === user.userId
          return
        }
        if (event.type !== 'message.changed') return
        const id = event.data.messageId
        if (seen.has(id)) return
        seen.add(id)
        if (seen.size > 1024) seen.delete(seen.values().next().value)
        const fetched = http.get(
          `${fixture.origin}/api/messages/${id}`,
          params(user, 'message.authorized-read'),
        )
        if (fetched.status !== 200) {
          unexpected.add(true)
          if ([401, 403, 404].includes(fetched.status)) permissionErrors.add(1)
          return
        }
        const value = fetched.json()
        const body = value.message?.body || '',
          match = /^benchmark-delivery:([0-9]+):/.exec(body)
        if (
          match &&
          Date.now() - Number(match[1]) >= 0 &&
          (mode !== 'full' || exec.instance.currentTestRunDuration > 302000)
        ) {
          delivery.add(Date.now() - Number(match[1]))
          deliverySamples.add(1)
        }
        unexpected.add(false)
      })
      socket.on('error', () => unexpected.add(true))
      socket.on('close', () => unexpected.add(!plannedClose))
      socket.setInterval(() => socket.send(JSON.stringify({ v: 1, type: 'ping', data: {} })), 20000)
      socket.setTimeout(
        () => {
          plannedClose = true
          socket.close()
        },
        (seconds + 5) * 1000,
      )
    },
  )
  hello.add(greeted && result?.status === 101)
}
/** A bounded connection storm is separate from the steady receive population. */
export function reconnect() {
  if (exec.scenario.iterationInTest >= (mode === 'full' ? 500 : 4)) {
    boundaryIterations.add(1)
    return
  }
  const user =
    fixture.users[
      exec.scenario.iterationInTest % Math.min(mode === 'full' ? 500 : 4, fixture.users.length)
    ]
  let greeted = false
  const result = ws.connect(
    `${fixture.origin.replace(/^https:/, 'wss:')}/ws`,
    params(user, 'ws.reconnect'),
    (socket) => {
      socket.on('message', (text) => {
        try {
          const event = JSON.parse(text)
          if (event.type === 'hello') greeted = event.data.userId === user.userId
        } catch {
          unexpected.add(true)
        }
      })
      socket.on('error', () => unexpected.add(true))
      socket.setTimeout(() => socket.close(), 2000)
    },
  )
  reconnected.add(1)
  hello.add(greeted && result?.status === 101)
  unexpected.add(!greeted || result?.status !== 101)
}
export function handleSummary(data) {
  return {
    '/result/summary.json': JSON.stringify(
      {
        format: 1,
        profile: mode,
        distribution,
        activeUsers: active,
        fastConnections: receivers,
        clientMatrix,
        sourceHash: fixture.sourceHash,
        dataset: fixture.dataset,
        releaseGate:
          'authorized weighted chat or separate hot-channel workload; combined admission requires independently verified background, slow-client and reconnect receipts',
        metrics: data.metrics,
      },
      null,
      2,
    ),
  }
}
