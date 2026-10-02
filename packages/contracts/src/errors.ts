/** Error codes and the unified error body (docs/05 section 1). `message` is a developer-facing English text. */
import { z } from 'zod'

export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 403,
  AI_BUDGET_EXHAUSTED: 503,
  AI_KEY_INVALID: 422,
  CONVERSATION_BANNED: 403,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  REQUEST_TIMEOUT: 408,
  INVALID_REQUEST_FRAMING: 400,
  AUTH_CHALLENGE_INVALID: 400,
  WINDOW_EXPIRED: 403,
  INVITE_INVALID: 400,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
  RESOURCE_GONE: 410,
  CONTEXT_CHANGED: 409,
  CALL_OUTCOME_UNKNOWN: 409,
  CAPACITY_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const

export type ErrorCode = keyof typeof ERROR_STATUS

export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[]

export const errorCodeSchema = z.enum(ERROR_CODES as [ErrorCode, ...ErrorCode[]])

export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
})
export type ErrorBody = z.infer<typeof errorBodySchema>

/** Application error carrying an API error code; domain code throws it, the HTTP layer renders it. */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined
  /** Extra response headers (for example Retry-After). */
  readonly headers: Record<string, string> | undefined

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      details?: Record<string, unknown>
      headers?: Record<string, string>
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.details = options.details
    this.headers = options.headers
  }

  get status(): number {
    return ERROR_STATUS[this.code]
  }
}
