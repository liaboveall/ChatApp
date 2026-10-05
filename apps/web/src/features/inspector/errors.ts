/**
 * The words for a refused change in the Inspector. The cases that need more than the general wording of
 * `describeError`: the list or the settings were changed by somebody else a moment ago (the screen has been refreshed),
 * the conversation was archived meanwhile, and the person's role no longer allows it.
 */
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { m } from '@/paraglide/messages.js'

export function inspectorError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'VERSION_CONFLICT') return m.inspector_error_changed()
    if (error.code === 'CONFLICT' && error.reason === 'archived')
      return m.inspector_error_archived()
    if (error.code === 'FORBIDDEN') return m.inspector_error_not_allowed()
    if (error.code === 'NOT_FOUND') return m.inspector_error_gone()
  }
  return describeError(error)
}

/** Whether the answer says the data the person acted on has moved on, so the screen should be refreshed. */
export const isStale = (error: unknown): boolean =>
  error instanceof ApiError && (error.code === 'VERSION_CONFLICT' || error.code === 'NOT_FOUND')
