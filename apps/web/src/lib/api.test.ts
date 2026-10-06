import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { ApiError, api, cancelSessionRequests, setUnauthenticatedHandler } from './api.ts'

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  fetchMock.mockReset()
  setUnauthenticatedHandler(undefined)
  vi.unstubAllGlobals()
})

describe('requests', () => {
  test('same origin, no cache, no referrer, JSON in and out, the idempotency key as a header', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: 'ok' }))
    const result = await api('/api/x', {
      json: { a: 1 },
      schema: z.object({ status: z.literal('ok') }),
      idempotencyKey: 'key-1',
      headers: { 'x-invite-code': 'ABC' },
    })
    expect(result).toEqual({ status: 'ok' })
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('/api/x')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.cache).toBe('no-store')
    expect(init?.referrerPolicy).toBe('no-referrer')
    expect(init?.body).toBe('{"a":1}')
    const headers = new Headers(init?.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('idempotency-key')).toBe('key-1')
    expect(headers.get('x-invite-code')).toBe('ABC')
  })

  test('a body-less call is a GET and needs no content type', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { n: 1 }))
    await api('/api/y', { schema: z.object({ n: z.number() }) })
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.method).toBe('GET')
    expect(new Headers(init?.headers).has('content-type')).toBe(false)
  })

  test('a response that does not match the contract is an error, never trusted data', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: 'surprise' }))
    await expect(
      api('/api/x', { schema: z.object({ status: z.literal('ok') }) }),
    ).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    })
  })
})

describe('errors', () => {
  test('the unified error body becomes code, details and request id', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(409, {
        error: {
          code: 'CONFLICT',
          message: 'Username is not available',
          details: { field: 'username', reason: 'taken' },
          requestId: 'r-1',
        },
      }),
    )
    const error = await api('/api/x', { json: {} }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      field: 'username',
      reason: 'taken',
      requestId: 'r-1',
    })
  })

  test('schema validation errors expose the paths of the offending fields', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(422, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'x',
          details: {
            issues: [
              { path: 'email', code: 'invalid_format' },
              { path: 'name', code: 'too_big' },
            ],
          },
          requestId: 'r',
        },
      }),
    )
    const error = (await api('/api/x', { json: {} }).catch((caught: unknown) => caught)) as ApiError
    expect(error.issuePaths).toEqual(['email', 'name'])
  })

  test('the sign-in failure keeps its flat shape', async () => {
    fetchMock.mockResolvedValueOnce(
      respond(403, { code: 'EMAIL_NOT_VERIFIED', message: 'Email is not verified' }),
    )
    await expect(
      api('/api/auth/sign-in/email', { json: {}, anonymous: true }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'EMAIL_NOT_VERIFIED',
    })
  })

  test('answers from the gateway map to codes by status; Retry-After is kept', async () => {
    const cases: Array<[number, string]> = [
      [408, 'REQUEST_TIMEOUT'],
      [413, 'PAYLOAD_TOO_LARGE'],
      [415, 'UNSUPPORTED_MEDIA_TYPE'],
      [429, 'RATE_LIMITED'],
      [502, 'GATEWAY'],
      [503, 'CAPACITY_UNAVAILABLE'],
      [504, 'GATEWAY'],
    ]
    for (const [status, code] of cases) {
      fetchMock.mockResolvedValueOnce(
        new Response('<html>bad gateway</html>', { status, headers: { 'retry-after': '7' } }),
      )
      const error = (await api('/api/x').catch((caught: unknown) => caught)) as ApiError
      expect(error.code, String(status)).toBe(code)
      expect(error.retryAfterSeconds).toBe(7)
    }
  })

  test('a request that never got an answer is NETWORK; an abort stays an abort', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(api('/api/x')).rejects.toMatchObject({ code: 'NETWORK', status: 0 })
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
    await expect(api('/api/x')).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('a lost session', () => {
  const unauthenticated = (): Response =>
    respond(401, {
      error: { code: 'UNAUTHENTICATED', message: 'Sign in required', requestId: 'r' },
    })

  test('a 401 on a signed-in call calls the handler once per answer', async () => {
    const handler = vi.fn()
    setUnauthenticatedHandler(handler)
    fetchMock.mockResolvedValueOnce(unauthenticated())
    await expect(api('/api/me/devices')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('a 401 on an anonymous call (the identity probe, sign-in) is just an answer', async () => {
    const handler = vi.fn()
    setUnauthenticatedHandler(handler)
    fetchMock.mockResolvedValueOnce(unauthenticated())
    await expect(api('/api/me', { anonymous: true })).rejects.toBeInstanceOf(ApiError)
    expect(handler).not.toHaveBeenCalled()
  })

  test('an ordinary refusal is not a lost session', async () => {
    const handler = vi.fn()
    setUnauthenticatedHandler(handler)
    for (const [status, code] of [
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
    ] as const) {
      fetchMock.mockResolvedValueOnce(
        respond(status, { error: { code, message: 'no', requestId: 'r' } }),
      )
      await expect(api('/api/x', { json: {} })).rejects.toMatchObject({ code })
    }
    expect(handler).not.toHaveBeenCalled()
  })
})

/**
 * D-175: a request belongs to the login session it was made in. When that session ends (or another begins) the browser is
 * told to give the request up, so that nothing it brings back (a status, a body, a cookie that the browser would apply
 * whatever the page thinks) reaches the next one; and an answer that gets through anyway is not delivered.
 */
describe('the session a request belongs to', () => {
  const unauthenticated = (): Response =>
    respond(401, {
      error: { code: 'UNAUTHENTICATED', message: 'Sign in required', requestId: 'r' },
    })

  /** A fetch that stays out until it is aborted, as the browser's does, and says so the way the browser's does. */
  const hangsUntilAborted = (): void => {
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
    )
  }

  /** A fetch that ignores its signal and answers when the test says: an answer that was already on its way. */
  const answersLater = (response: Response): (() => void) => {
    let answer: () => void = () => undefined
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(response)
        }),
    )
    return () => answer()
  }

  test('a request whose session ended is given up, and the caller sees an abort', async () => {
    hangsUntilAborted()
    const pending = api('/api/conversations', { json: {} })
    const outcome = pending.catch((caught: unknown) => caught)
    cancelSessionRequests()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
  })

  test('every kind of request is given up with its session: signed in or not, with a schema or without', async () => {
    const outcomes: Promise<unknown>[] = []
    for (const options of [
      {},
      { anonymous: true },
      { schema: z.object({ n: z.number() }) },
      { method: 'DELETE' as const },
    ]) {
      hangsUntilAborted()
      outcomes.push(api('/api/x', options).catch((caught: unknown) => caught))
    }
    cancelSessionRequests()
    for (const outcome of await Promise.all(outcomes)) {
      expect(outcome).toMatchObject({ name: 'AbortError' })
    }
  })

  test('a 401 that arrives after its session ended is not a lost session of the one that is here now', async () => {
    const handler = vi.fn()
    setUnauthenticatedHandler(handler)
    const answer = answersLater(unauthenticated())
    const outcome = api('/api/conversations', { json: {} }).catch((caught: unknown) => caught)
    cancelSessionRequests()
    answer()
    // Not the 401 either: a failure that says nothing about whoever is here now is nobody's to be told (D-171).
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(handler).not.toHaveBeenCalled()
  })

  test('an answer that arrives after its session ended is not delivered', async () => {
    const answer = answersLater(respond(200, { n: 1 }))
    const outcome = api('/api/x', { schema: z.object({ n: z.number() }) }).catch(
      (caught: unknown) => caught,
    )
    cancelSessionRequests()
    answer()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
  })

  test('an answer that arrives with no schema to read is not delivered either', async () => {
    const answer = answersLater(respond(200, { status: 'ok' }))
    const outcome = api('/api/x', { method: 'POST' }).catch((caught: unknown) => caught)
    cancelSessionRequests()
    answer()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
  })

  test('the session ending while the body of an answer is being read gives the request up', async () => {
    const handler = vi.fn()
    setUnauthenticatedHandler(handler)
    let end: () => void = () => undefined
    const body = new Response(
      new ReadableStream({
        start(controller) {
          end = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ n: 1 })))
            controller.close()
          }
        },
      }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )
    fetchMock.mockResolvedValueOnce(body)
    const outcome = api('/api/x', { json: {} }).catch((caught: unknown) => caught)
    // The headers are in, the body is not: the session ends in between.
    await new Promise((resolve) => setTimeout(resolve, 0))
    cancelSessionRequests()
    end()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(handler).not.toHaveBeenCalled()
  })

  test('the session ending while the body of a good answer is being read gives the request up too', async () => {
    let end: () => void = () => undefined
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            end = () => {
              controller.enqueue(new TextEncoder().encode(JSON.stringify({ n: 1 })))
              controller.close()
            }
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    const outcome = api('/api/x', { schema: z.object({ n: z.number() }) }).catch(
      (caught: unknown) => caught,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    cancelSessionRequests()
    end()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
  })

  test('a request made in the session that is current is untouched by the end of the one before', async () => {
    const handler = vi.fn()
    setUnauthenticatedHandler(handler)
    cancelSessionRequests()
    fetchMock.mockResolvedValueOnce(respond(200, { n: 1 }))
    await expect(api('/api/x', { schema: z.object({ n: z.number() }) })).resolves.toEqual({
      n: 1,
    })
    fetchMock.mockResolvedValueOnce(unauthenticated())
    await expect(api('/api/x', { json: {} })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  test('a request keeps the signal of the caller: the caller can still give it up on its own', async () => {
    hangsUntilAborted()
    const own = new AbortController()
    const outcome = api('/api/x', { signal: own.signal }).catch((caught: unknown) => caught)
    own.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    // The session was not touched by that: the next request goes out as usual.
    fetchMock.mockResolvedValueOnce(respond(200, {}))
    await expect(api('/api/x')).resolves.toBeUndefined()
  })

  test('the browser is given one signal that follows both: the session that ends, and the caller who gives up', async () => {
    fetchMock.mockResolvedValue(respond(200, {}))
    const own = new AbortController()
    await api('/api/x', { signal: own.signal })
    await api('/api/x', { signal: own.signal })
    const [byCaller, bySession] = fetchMock.mock.calls.map((call) => call[1]?.signal as AbortSignal)
    expect([byCaller?.aborted, bySession?.aborted]).toEqual([false, false])
    own.abort()
    expect([byCaller?.aborted, bySession?.aborted]).toEqual([true, true])
    // The same signal of the session serves a request that has no caller signal.
    fetchMock.mockClear()
    await api('/api/x')
    const alone = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal
    expect(alone.aborted).toBe(false)
    cancelSessionRequests()
    expect(alone.aborted).toBe(true)
  })
})
