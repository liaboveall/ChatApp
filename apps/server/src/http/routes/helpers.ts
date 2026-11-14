/**
 * Shared pieces of the route modules: request and response wrappers, the error set every authenticated route can answer,
 * and the few request readings several modules need.
 */
import { AppError, errorBodySchema, IDEMPOTENCY_KEY_HEADER } from '@chatapp/contracts'
import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { HttpEnv } from '../context.ts'

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})

/** A JSON request body the route cannot do without. */
export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  required: true as const,
  content: { 'application/json': { schema } },
})

export const err = (description: string) => json(errorBodySchema, description)

export const idParam = z.object({ id: z.uuid() })

/** What every route behind the session guard may answer besides its own results (docs/05 section 1). */
export const guardedErrors = {
  401: err('Not signed in'),
  429: err('Rate limited (Retry-After says when to try again)'),
} as const

export const accessErrors = {
  ...guardedErrors,
  403: err('Visible, but not allowed (the reason is in details)'),
  404: err('Not found, or not visible to you'),
} as const

/** The body of every write that has nothing to return but its success. */
export const OK = { status: 'ok' } as const

/**
 * The caller's Idempotency-Key, or an empty string when the header is missing. The domain checks the format where it
 * claims the key (`assertIdempotencyKey`), and an empty key fails that check.
 */
export const idempotencyKeyOf = (c: Context<HttpEnv>): string =>
  c.req.header(IDEMPOTENCY_KEY_HEADER) ?? ''

/** For the operations that name the missing header before anything else is looked at. */
export function requireIdempotencyKey(c: Context<HttpEnv>): string {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER)
  if (key === undefined) {
    throw new AppError('VALIDATION_FAILED', 'Idempotency-Key header is required', {
      details: { field: 'idempotencyKey' },
    })
  }
  return key
}
