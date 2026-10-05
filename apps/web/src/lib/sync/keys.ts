/**
 * Query keys of everything the sync layer and the conversation screens store (D-070, D-150). Every key starts with
 * `['u', userId, authEpoch]`, so a different person, or the same person after a password change, can never read what
 * another scope cached; the timeline key also carries the membership, so a re-joined conversation starts from nothing.
 * `['me']` keeps its M1 key (the identity probe reads it before there is a scope).
 */
import type { SyncScope } from './types.ts'

type Prefix = readonly ['u', string, number]

const prefix = (scope: Pick<SyncScope, 'userId' | 'authEpoch'>): Prefix =>
  ['u', scope.userId, scope.authEpoch] as const

export const syncKeys = {
  /** Everything of one scope: removing it forgets the account's conversation data. */
  scope: prefix,
  conversations: (scope: SyncScope) => [...prefix(scope), 'conversations'] as const,
  users: (scope: SyncScope) => [...prefix(scope), 'users'] as const,
  /** Everything of one conversation, whatever the membership. */
  conversation: (scope: SyncScope, conversationId: string) =>
    [...prefix(scope), 'conv', conversationId] as const,
  timeline: (scope: SyncScope, conversationId: string, membershipId: string) =>
    [...prefix(scope), 'conv', conversationId, 'timeline', membershipId] as const,
  members: (scope: SyncScope, conversationId: string) =>
    [...prefix(scope), 'conv', conversationId, 'members'] as const,
  bans: (scope: SyncScope, conversationId: string) =>
    [...prefix(scope), 'conv', conversationId, 'bans'] as const,
  invites: (scope: SyncScope, conversationId: string) =>
    [...prefix(scope), 'conv', conversationId, 'invites'] as const,
  profile: (scope: SyncScope, userId: string) => [...prefix(scope), 'profile', userId] as const,
  discovery: (scope: SyncScope, query: string) => [...prefix(scope), 'discovery', query] as const,
  archived: (scope: SyncScope) => [...prefix(scope), 'archived'] as const,
}

/** True for a key that belongs to the given scope's account and generation. */
export function isScopeKey(
  key: readonly unknown[],
  scope: Pick<SyncScope, 'userId' | 'authEpoch'>,
): boolean {
  return key[0] === 'u' && key[1] === scope.userId && key[2] === scope.authEpoch
}

/** True for any key of the sync layer, whatever scope: what a reset removes besides `['me']` (which the session resets). */
export function isSyncKey(key: readonly unknown[]): boolean {
  return key[0] === 'u'
}
