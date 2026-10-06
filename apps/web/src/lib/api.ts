/**
 * The only place that talks HTTP to the API (docs/05 section 1). Same-origin, JSON, cookie session. Responses are
 * validated with the zod schemas from `@chatapp/contracts`; every failure becomes an `ApiError` with a stable `code`
 * the UI maps to a localized message (the English `message` from the server is for developers, never shown).
 */
import {
  type ErrorCode,
  errorBodySchema,
  IDEMPOTENCY_KEY_HEADER,
  signInErrorSchema,
} from '@chatapp/contracts'
import type { z } from 'zod'

export type ApiErrorCode =
  | ErrorCode
  | 'INVALID_EMAIL_OR_PASSWORD'
  | 'EMAIL_NOT_VERIFIED'
  | 'ACCOUNT_NOT_ACTIVE'
  /** The request never got an answer (offline, DNS, connection reset, CORS). */
  | 'NETWORK'
  /** The gateway answered with something that is not our error body (502, 504, HTML page). */
  | 'GATEWAY'
  /** The answer did not match the contract. */
  | 'BAD_RESPONSE'

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly details: Record<string, unknown> | undefined
  readonly requestId: string | undefined
  readonly retryAfterSeconds: number | undefined

  constructor(
    status: number,
    code: ApiErrorCode,
    options: {
      message?: string
      details?: Record<string, unknown>
      requestId?: string
      retryAfterSeconds?: number
    } = {},
  ) {
    super(options.message ?? code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = options.details
    this.requestId = options.requestId
    this.retryAfterSeconds = options.retryAfterSeconds
  }

  /** `details.field` and `details.reason` as sent by domain validation errors. */
  get field(): string | undefined {
    const value = this.details?.field
    return typeof value === 'string' ? value : undefined
  }

  get reason(): string | undefined {
    const value = this.details?.reason
    return typeof value === 'string' ? value : undefined
  }

  /** Field paths reported by schema validation (`details.issues[].path`). */
  get issuePaths(): string[] {
    const issues = this.details?.issues
    if (!Array.isArray(issues)) return []
    return issues.flatMap((issue: unknown) => {
      const path = (issue as { path?: unknown } | null)?.path
      return typeof path === 'string' ? [path] : []
    })
  }
}

let unauthenticatedHandler: (() => void) | undefined

/** Registered by the session module: called once when a signed-in request is answered with 401. */
export function setUnauthenticatedHandler(handler: (() => void) | undefined): void {
  unauthenticatedHandler = handler
}

/**
 * The login session that requests are made in (D-175). Every request made now belongs to it and carries its signal; the
 * session module cancels it when the session ends or another one begins. The browser is told to give the requests up, and
 * that is the point: what the browser does with an answer (it applies the cookie lines in its headers, deletions included)
 * does not wait for the page to look at the answer, so a page that merely ignores a late answer has not kept it from
 * deleting the cookie of whoever signed in since. A request that has been given up gets no answer in the browser.
 */
let sessionRequests = new AbortController()

/**
 * The session ended, or another began: everything that was asked in the one before is given up, and what is asked from now
 * on belongs to the next. Called by the session module only.
 */
export function cancelSessionRequests(): void {
  const ended = sessionRequests
  sessionRequests = new AbortController()
  ended.abort()
}

/** Whether a failure is a request given up (by the caller, or because its session ended), not something the server said. */
export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export type RequestOptions<S extends z.ZodType | undefined> = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  json?: unknown
  /** Validates and types the response. Omitted: the body is ignored. */
  schema?: S
  headers?: Record<string, string>
  idempotencyKey?: string
  signal?: AbortSignal
  /**
   * The endpoint is open to anonymous callers (sign-in, registration, the `/api/me` probe): a 401 there is an answer,
   * not a lost session.
   */
  anonymous?: boolean
}

function gatewayCode(status: number): ApiErrorCode {
  switch (status) {
    case 408:
      return 'REQUEST_TIMEOUT'
    case 413:
      return 'PAYLOAD_TOO_LARGE'
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE'
    case 429:
      return 'RATE_LIMITED'
    case 503:
      return 'CAPACITY_UNAVAILABLE'
    default:
      return 'GATEWAY'
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : undefined
}

async function toError(response: Response): Promise<ApiError> {
  const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'))
  const body: unknown = await response.json().catch(() => undefined)

  const unified = errorBodySchema.safeParse(body)
  if (unified.success) {
    const { code, message, details, requestId } = unified.data.error
    return new ApiError(response.status, code, { message, details, requestId, retryAfterSeconds })
  }
  // Sign-in keeps the SDK's flat { code, message } shape (docs/05 section 1).
  const flat = signInErrorSchema.safeParse(body)
  if (flat.success) {
    return new ApiError(response.status, flat.data.code, {
      message: flat.data.message,
      retryAfterSeconds,
    })
  }
  return new ApiError(response.status, gatewayCode(response.status), { retryAfterSeconds })
}

export async function api<S extends z.ZodType | undefined = undefined>(
  path: string,
  options: RequestOptions<S> = {},
): Promise<S extends z.ZodType ? z.infer<S> : undefined> {
  const headers = new Headers(options.headers)
  headers.set('accept', 'application/json')
  if (options.json !== undefined) headers.set('content-type', 'application/json')
  if (options.idempotencyKey !== undefined)
    headers.set(IDEMPOTENCY_KEY_HEADER, options.idempotencyKey)

  // Taken now, before anything is awaited: the session this request is made in is the one that is current at this moment.
  const session = sessionRequests.signal
  const signal = options.signal === undefined ? session : AbortSignal.any([session, options.signal])

  let response: Response
  try {
    response = await fetch(path, {
      method: options.method ?? (options.json !== undefined ? 'POST' : 'GET'),
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal,
    })
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error
    throw new ApiError(0, 'NETWORK')
  }
  // Whatever the answer says is for the session the request was made in. If that one is over, nobody here is told anything
  // by it: not the result, not the failure, and no 401 may end the session of whoever is here now. The browser has
  // given the request up by then, so this is for an answer that was already on its way when the session ended.
  signal.throwIfAborted()

  if (!response.ok) {
    const failure = await toError(response)
    signal.throwIfAborted()
    if (failure.status === 401 && failure.code === 'UNAUTHENTICATED' && !options.anonymous) {
      unauthenticatedHandler?.()
    }
    throw failure
  }

  if (!options.schema) return undefined as never
  const body: unknown = await response.json().catch(() => undefined)
  signal.throwIfAborted()
  const parsed = options.schema.safeParse(body)
  if (!parsed.success) throw new ApiError(response.status, 'BAD_RESPONSE')
  return parsed.data as never
}

/** A fresh idempotency key. Forms reuse one key while the request body stays the same (docs/05 section 1). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}
