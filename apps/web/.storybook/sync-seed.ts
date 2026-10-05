/**
 * What a story puts into the stores of the sync layer, so a component that reads people and conversations from there
 * (the sidebar, the composer's reply bar) shows what it shows in the app. The visual tests photograph each story in its own
 * page load, so nothing needs to be undone between them; `clearSeed` is for a person browsing the stories.
 */

import type { UserSummary } from '@chatapp/contracts'
import type { QueryClient } from '@tanstack/react-query'
import { syncKeys } from '../src/lib/sync/keys.ts'
import { useSyncUi } from '../src/lib/sync/state.ts'
import type { ConversationIndex, SyncScope } from '../src/lib/sync/types.ts'
import { sampleMe } from './mock-api.ts'

export const storyScope: SyncScope = {
  userId: sampleMe.id,
  authEpoch: sampleMe.authEpoch,
  restoreEpoch: sampleMe.restoreEpoch,
  generation: 1,
}

/** The people of the dictionary, and the scope they belong to. */
export function seedUsers(client: QueryClient, users: UserSummary[]): void {
  client.setQueryData(
    syncKeys.users(storyScope),
    Object.fromEntries(users.map((user) => [user.id, user])),
  )
  useSyncUi.setState({ scope: storyScope })
}

/** The conversation list of the sidebar, as loaded. */
export function seedConversations(client: QueryClient, index: ConversationIndex): void {
  client.setQueryData(syncKeys.conversations(storyScope), index)
  useSyncUi.setState({ scope: storyScope, ready: true })
}

export function clearSeed(): void {
  useSyncUi.setState({ scope: null, ready: false })
}
