import { describe, expect, test } from 'bun:test'
import { createECDH, randomBytes } from 'node:crypto'
import type { PushPayload } from '@chatapp/contracts'
import {
  type CapturedPush,
  classifyStatus,
  createCaptureTransport,
  createPushSender,
  type PushMessage,
} from './push.ts'
import { createEndpointPolicy, EndpointError } from './push-endpoints.ts'
import type { PushRequest, PushTransport } from './push-transport.ts'
import { TransportError } from './push-transport.ts'
import { b64u, decryptWebPush, generateVapidKeys, verifyVapidJwt } from './web-push.ts'

const vapid = { ...generateVapidKeys(), subject: 'mailto:ops@example.test' }
const policy = createEndpointPolicy({
  lookup: async () => [{ address: '142.250.80.74', family: 4 }],
})

function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    target: (endpoint = 'https://fcm.googleapis.com/fcm/send/abc') => ({
      endpoint,
      p256dh: b64u.encode(ecdh.getPublicKey()),
      auth: b64u.encode(auth),
    }),
    receiver: { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth },
  }
}

const payload: PushPayload = {
  v: 1,
  userId: crypto.randomUUID(),
  kind: 'message',
  title: 'ChatApp',
  body: '你有新消息',
  url: '/c/00000000-0000-0000-0000-000000000000',
  tag: 'c-00000000-0000-0000-0000-000000000000',
  unread: 3,
}
const message: PushMessage = { payload, urgency: 'high', topic: 'abcDEF123' }

function recording(
  answer: (request: PushRequest) => Promise<{ status: number; retryAfterSeconds: number | null }>,
) {
  const requests: PushRequest[] = []
  const transport: PushTransport = {
    post: async (request) => {
      requests.push(request)
      return await answer(request)
    },
  }
  return { transport, requests }
}

describe('the request that goes to the push service', () => {
  test('is encrypted for the browser, signed with the VAPID key and carries the delivery hints', async () => {
    const who = browser()
    const { transport, requests } = recording(async () => ({
      status: 201,
      retryAfterSeconds: null,
    }))
    const sender = createPushSender({
      vapid,
      transport,
      policy,
      now: () => Date.UTC(2026, 9, 9, 12),
    })
    const outcome = await sender.send(who.target(), message)
    expect(outcome).toEqual({ kind: 'delivered', status: 201 })
    const request = requests[0]
    expect(request?.endpoint).toBe('https://fcm.googleapis.com/fcm/send/abc')
    const headers = request?.headers ?? {}
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers['Content-Type']).toBe('application/octet-stream')
    expect(headers.TTL).toBe('86400')
    expect(headers.Urgency).toBe('high')
    expect(headers.Topic).toBe('abcDEF123')
    // The browser reads exactly what was meant for it...
    const plain = decryptWebPush(request?.body ?? new Uint8Array(), who.receiver)
    expect(JSON.parse(plain.toString('utf8'))).toEqual(payload)
    // ...and the authorization is acceptable to the push service: right audience, short life, our key.
    const match = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(headers.Authorization ?? '')
    expect(match?.[2]).toBe(vapid.publicKey)
    expect(verifyVapidJwt(match?.[1] ?? '', vapid.publicKey)).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor(Date.UTC(2026, 9, 9, 12) / 1000) + 12 * 3600,
      sub: 'mailto:ops@example.test',
    })
  })

  test('the audience is the push service of the endpoint, whichever it is', async () => {
    const who = browser()
    const { transport, requests } = recording(async () => ({
      status: 201,
      retryAfterSeconds: null,
    }))
    const sender = createPushSender({ vapid, transport, policy })
    await sender.send(who.target('https://web.push.apple.com/token'), message)
    const jwt = /t=([\w.-]+),/.exec(requests[0]?.headers.Authorization ?? '')?.[1] ?? ''
    expect(verifyVapidJwt(jwt, vapid.publicKey)?.aud).toBe('https://web.push.apple.com')
  })

  test('a message without a topic sends none', async () => {
    const who = browser()
    const { transport, requests } = recording(async () => ({
      status: 201,
      retryAfterSeconds: null,
    }))
    await createPushSender({ vapid, transport, policy }).send(who.target(), {
      payload,
      urgency: 'normal',
    })
    expect(requests[0]?.headers.Topic).toBeUndefined()
    expect(requests[0]?.headers.Urgency).toBe('normal')
  })

  test('refuses to start with a key pair that does not belong together', () => {
    const { transport } = recording(async () => ({ status: 201, retryAfterSeconds: null }))
    expect(() =>
      createPushSender({
        vapid: { ...vapid, privateKey: generateVapidKeys().privateKey },
        transport,
        policy,
      }),
    ).toThrow()
  })
})

describe('what each answer means', () => {
  const cases: Array<[number, number | null, string]> = [
    [200, null, 'delivered'],
    [201, null, 'delivered'],
    [202, null, 'delivered'],
    [404, null, 'gone'],
    [410, null, 'gone'],
    [400, null, 'rejected'],
    [401, null, 'rejected'],
    [403, null, 'rejected'],
    [413, null, 'rejected'],
    [301, null, 'rejected'],
    [307, null, 'rejected'],
    [408, null, 'retry'],
    [429, 30, 'retry'],
    [500, null, 'retry'],
    [502, null, 'retry'],
    [503, 120, 'retry'],
  ]
  for (const [status, retryAfter, kind] of cases) {
    test(`${status} is ${kind}`, () => {
      const outcome = classifyStatus(status, retryAfter)
      expect(outcome.kind).toBe(kind as typeof outcome.kind)
      if (outcome.kind === 'retry')
        expect(outcome.retryAfterMs).toBe(retryAfter === null ? null : retryAfter * 1000)
    })
  }
})

describe('what it does before and when things go wrong', () => {
  const sendWith = async (
    answer: () => Promise<{ status: number; retryAfterSeconds: number | null }>,
    target?: ReturnType<ReturnType<typeof browser>['target']>,
  ) => {
    const { transport, requests } = recording(answer)
    const who = browser()
    const outcome = await createPushSender({ vapid, transport, policy }).send(
      target ?? who.target(),
      message,
    )
    return { outcome, requests }
  }

  test('an endpoint that is no longer acceptable is dropped without a request', async () => {
    const who = browser()
    const { outcome, requests } = await sendWith(
      async () => ({ status: 201, retryAfterSeconds: null }),
      who.target('https://evil.example/x'),
    )
    expect(outcome).toEqual({ kind: 'gone', reason: 'endpoint_host_not_allowed', status: null })
    expect(requests).toHaveLength(0)
  })

  test('keys that are not a key: the subscription is useless', async () => {
    const { outcome, requests } = await sendWith(
      async () => ({ status: 201, retryAfterSeconds: null }),
      {
        endpoint: 'https://fcm.googleapis.com/x',
        p256dh: 'AAAA',
        auth: 'AAAA',
      },
    )
    expect(outcome).toEqual({ kind: 'gone', reason: 'bad_subscription_keys', status: null })
    expect(requests).toHaveLength(0)
  })

  test('a payload that does not fit is refused, not cut', async () => {
    const who = browser()
    const { transport, requests } = recording(async () => ({
      status: 201,
      retryAfterSeconds: null,
    }))
    const big = { ...message, payload: { ...payload, body: 'x'.repeat(4000) } }
    const outcome = await createPushSender({ vapid, transport, policy }).send(who.target(), big)
    expect(outcome).toEqual({ kind: 'rejected', reason: 'payload_too_large', status: null })
    expect(requests).toHaveLength(0)
  })

  test('the name now resolves into the network: removed; the resolver is down: tried again', async () => {
    expect(
      (
        await sendWith(async () => {
          throw new EndpointError('non_public_address')
        })
      ).outcome,
    ).toEqual({
      kind: 'gone',
      reason: 'endpoint_non_public_address',
      status: null,
    })
    expect(
      (
        await sendWith(async () => {
          throw new EndpointError('dns_failed')
        })
      ).outcome,
    ).toEqual({
      kind: 'retry',
      reason: 'dns_failed',
      retryAfterMs: null,
    })
  })

  test('no connection, no answer in time, a broken answer: tried again; a request that could not be written: refused', async () => {
    for (const code of ['timeout', 'connect_failed', 'bad_response'] as const) {
      const { outcome } = await sendWith(async () => {
        throw new TransportError(code)
      })
      expect(outcome).toEqual({ kind: 'retry', reason: code, retryAfterMs: null })
    }
    expect(
      (
        await sendWith(async () => {
          throw new TransportError('bad_request')
        })
      ).outcome.kind,
    ).toBe('rejected')
    expect(
      (
        await sendWith(async () => {
          throw new Error('something else')
        })
      ).outcome.kind,
    ).toBe('retry')
  })
})

describe('the simulated push service of the end-to-end tests', () => {
  test('records the whole request and says it was accepted', async () => {
    const stored: CapturedPush[] = []
    const who = browser()
    const sender = createPushSender({
      vapid,
      policy,
      transport: createCaptureTransport({ push: async (entry) => void stored.push(entry) }, () =>
        Date.UTC(2026, 9, 9),
      ),
    })
    expect(await sender.send(who.target(), message)).toEqual({ kind: 'delivered', status: 201 })
    expect(stored).toHaveLength(1)
    expect(stored[0]?.at).toBe('2026-10-09T00:00:00.000Z')
    const plain = decryptWebPush(b64u.decode(stored[0]?.bodyBase64Url ?? ''), who.receiver)
    expect(JSON.parse(plain.toString('utf8'))).toEqual(payload)
  })
})
