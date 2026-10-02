/**
 * Turns failures into text for the person in front of the screen. The server's English `message` is for developers
 * and never shown; the code (and for validation errors the field and reason) decides the wording.
 */
import type { PasswordProblem } from '@chatapp/contracts'
import { m } from '@/paraglide/messages.js'
import { ApiError } from './api.ts'

export function passwordProblemMessage(problem: PasswordProblem | string | undefined): string {
  switch (problem) {
    case 'too_short':
      return m.password_problem_too_short()
    case 'too_long':
      return m.password_problem_too_long()
    case 'too_common':
      return m.password_problem_too_common()
    case 'too_simple':
      return m.password_problem_too_simple()
    case 'contains_identity':
      return m.password_problem_contains_identity()
    default:
      return m.password_problem_generic()
  }
}

/** A general message for any failure that the page did not handle itself. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return m.error_unknown()
  switch (error.code) {
    case 'NETWORK':
      return m.error_network()
    case 'RATE_LIMITED':
      return error.retryAfterSeconds === undefined
        ? m.error_rate_limited()
        : m.error_rate_limited_seconds({ seconds: error.retryAfterSeconds })
    case 'REQUEST_TIMEOUT':
      return m.error_timeout()
    case 'PAYLOAD_TOO_LARGE':
      return m.error_too_large()
    case 'GATEWAY':
    case 'CAPACITY_UNAVAILABLE':
      return m.error_unavailable()
    case 'UNAUTHENTICATED':
      return m.error_unauthenticated()
    case 'FORBIDDEN':
      return m.error_forbidden()
    case 'NOT_FOUND':
      return m.error_not_found()
    case 'VALIDATION_FAILED':
      return m.error_validation()
    case 'CONFLICT':
    case 'VERSION_CONFLICT':
    case 'IDEMPOTENCY_CONFLICT':
      return m.error_conflict()
    case 'QUOTA_EXCEEDED':
      return m.error_quota()
    default:
      return error.requestId
        ? m.error_internal_with_id({ requestId: error.requestId })
        : m.error_internal()
  }
}
