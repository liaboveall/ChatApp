import { ApiError } from '@/lib/api.ts'
import { m } from '@/paraglide/messages.js'

/** What went wrong when joining, in words that fit joining; undefined for anything the general wording covers. */
export function joinErrorText(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  if (error.code === 'CONVERSATION_BANNED') return m.join_banned()
  if (error.code === 'QUOTA_EXCEEDED') return m.new_conversation_limit()
  if (error.code === 'INVITE_INVALID') return m.join_invite_invalid()
  return undefined
}
