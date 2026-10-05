import type { UserSummary } from '@chatapp/contracts'
import { m } from '@/paraglide/messages.js'

/** How a person is named on screen: an account that was deleted has no name any more. */
export const nameOf = (user: Pick<UserSummary, 'displayName' | 'deleted'>): string =>
  user.deleted ? m.user_deleted() : user.displayName
