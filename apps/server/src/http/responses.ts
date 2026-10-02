import { AppError, ERROR_STATUS, type ErrorCode } from '@chatapp/contracts'
import type { Context, ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describeError, type Logger } from '../lib/logger.ts'
import type { HttpEnv } from './context.ts'

/** Minimal shape of the SDK's APIError, which carries its own status and `{code, message}` body. */
type SdkApiError = {
  name: string
  statusCode: number
  body?: { code?: unknown; message?: unknown }
}

export function isSdkApiError(error: unknown): error is SdkApiError {
  return (
    error instanceof Error &&
    error.name === 'APIError' &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
  )
}

/** The unified error body (docs/05 section 1). `message` is developer-facing English; clients localize by `code`. */
export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
) {
  return { error: { code, message, ...(details ? { details } : {}), requestId } }
}

export function errorResponse(
  c: Context<HttpEnv>,
  code: ErrorCode,
  message: string,
  options: { details?: Record<string, unknown>; headers?: Record<string, string> } = {},
): Response {
  const response = c.json(
    errorBody(code, message, c.get('requestId') ?? 'unknown', options.details),
    ERROR_STATUS[code],
  )
  for (const [name, value] of Object.entries(options.headers ?? {}))
    response.headers.set(name, value)
  return response
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'INVALID_REQUEST_FRAMING',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  408: 'REQUEST_TIMEOUT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
}

export function createErrorHandler(log: Logger): ErrorHandler<HttpEnv> {
  return (error, c) => {
    if (error instanceof AppError) {
      return errorResponse(c, error.code, error.message, {
        details: error.details,
        headers: error.headers,
      })
    }
    if (error instanceof HTTPException) {
      const code = STATUS_TO_CODE[error.status] ?? 'INTERNAL'
      return errorResponse(c, code, code === 'INTERNAL' ? 'Internal error' : error.message)
    }
    // Anything else is a bug or an outage: record the class and codes only (never the message) and answer generically.
    log.error('http.unhandled_error', { requestId: c.get('requestId'), ...describeError(error) })
    return errorResponse(c, 'INTERNAL', 'Internal error')
  }
}
