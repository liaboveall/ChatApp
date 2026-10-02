import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { ApiError, api, setUnauthenticatedHandler } from './api.ts'

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
})
