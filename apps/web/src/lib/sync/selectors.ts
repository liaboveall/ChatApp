/**
 * What the screens derive from the cache, as pure functions (D-150, docs/01 section 4.4, docs/02 section 7): which
 * conversations the sidebar shows and in which groups and order, the unread count, the name a conversation goes by.
 * Nothing here reads a store or a clock, so every rule is exercised directly.
 */
import type { Conversation, UserSummary } from '@chatapp/contracts'
import { unreadOf } from './state.ts'
import type { ConversationIndex, UsersByid } from './types.ts'

export type SidebarGroupKey = 'pinned' | 'channel' | 'group' | 'dm' | 'agent'

export type SidebarItem = {
  conversation: Conversation
  /** Unread messages as shown: the server's position, or the one this client already claimed, whichever is further. */
  unread: number
  /** The preview is not shown until a fresh read (two versions that could not be ordered met). */
  previewHidden: boolean
}

export type SidebarGroup = { key: SidebarGroupKey; items: SidebarItem[] }

/** Whether the sidebar lists this conversation: mine, not a hidden direct message, not archived (docs/05 section 3.3). */
export function isListed(conversation: Conversation): boolean {
  return (
    conversation.me !== null &&
    conversation.me.hiddenAt === null &&
    conversation.archivedAt === null &&
    conversation.panelForConversationId === null
  )
}

/** Newest activity first; conversations that never had a message come after, by name. */
function byActivity(a: Conversation, b: Conversation): number {
  if (a.lastMessageAt !== null && b.lastMessageAt !== null) {
    return b.lastMessageAt < a.lastMessageAt ? -1 : b.lastMessageAt > a.lastMessageAt ? 1 : 0
  }
  if (a.lastMessageAt !== null) return -1
  if (b.lastMessageAt !== null) return 1
  return displayName(a).localeCompare(displayName(b))
}

const byPinned = (a: Conversation, b: Conversation): number =>
  (b.me?.pinnedAt ?? '') < (a.me?.pinnedAt ?? '')
    ? -1
    : (b.me?.pinnedAt ?? '') > (a.me?.pinnedAt ?? '')
      ? 1
      : 0

/** Pinned first, then channels, groups and direct messages; empty groups are left out. */
export function sidebarGroups(
  index: ConversationIndex,
  pendingRead: Record<string, number>,
): SidebarGroup[] {
  const listed = Object.values(index.byId).filter(isListed)
  const item = (conversation: Conversation): SidebarItem => ({
    conversation,
    unread: unreadOf(
      conversation.lastSeq,
      conversation.me?.lastReadSeq ?? 0,
      pendingRead[conversation.id],
    ),
    previewHidden: conversation.id in index.previewHidden,
  })
  const pinned = listed.filter((c) => c.me?.pinnedAt != null).sort(byPinned)
  const rest = listed.filter((c) => c.me?.pinnedAt == null)
  const kinds: Array<[SidebarGroupKey, Conversation['kind']]> = [
    ['channel', 'channel'],
    ['group', 'group'],
    ['dm', 'dm'],
    ['agent', 'agent'],
  ]
  const groups: SidebarGroup[] = [{ key: 'pinned', items: pinned.map(item) }]
  for (const [key, kind] of kinds) {
    groups.push({
      key,
      items: rest
        .filter((c) => c.kind === kind)
        .sort(byActivity)
        .map(item),
    })
  }
  return groups.filter((group) => group.items.length > 0)
}

/** The conversations in the order the sidebar shows them (for ⌥↑ and ⌥↓). */
export const sidebarOrder = (groups: SidebarGroup[]): SidebarItem[] =>
  groups.flatMap((group) => group.items)

/** Label of the person's own reminder conversation; the stored name is only a fallback (set by the app at start). */
let remindersLabel = ''
export function setRemindersLabel(label: string): void {
  remindersLabel = label
}

/** What a conversation is called: its name, or for a direct message the other person's display name. */
export function displayName(
  conversation: Pick<Conversation, 'kind' | 'name' | 'dmPeer'> &
    Partial<Pick<Conversation, 'agentPurpose'>>,
  fallback = '',
): string {
  if (conversation.kind === 'dm') return conversation.dmPeer?.displayName ?? fallback
  if (conversation.agentPurpose === 'reminders' && remindersLabel) return remindersLabel
  return conversation.name ?? fallback
}

/** The person to show for a user id: the dictionary entry, or nothing (the caller words "a member" or "deleted account"). */
export const userOf = (users: UsersByid, id: string | null): UserSummary | undefined =>
  id === null ? undefined : users[id]
