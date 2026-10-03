/** Shared pieces of the route declarations: response wrappers and the error set every authenticated route can answer. */
import { errorBodySchema } from '@chatapp/contracts'
import { z } from '@hono/zod-openapi'

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
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
