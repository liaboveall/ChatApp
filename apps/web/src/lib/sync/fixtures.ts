/**
 * Builders for the unit tests of the sync layer: complete, valid DTOs with sensible defaults, so a test names only the
 * fields it is about. Not imported by application code.
 */
import type { Conversation, ConversationMe, Me, Message, UserSummary } from '@chatapp/contracts'

/** A valid, readable UUID for a small number (the contracts validate the format). */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const ISO = '2026-10-04T08:00:00.000Z'

export function makeUser(n: number, patch: Partial<UserSummary> = {}): UserSummary {
  return {
    id: uuid(n),
    profileVersion: 1,
    username: `user${n}`,
    displayName: `User ${n}`,
    avatarUrl: null,
    isBot: false,
    deleted: false,
    ...patch,
  }
}

export function makeMessage(seq: number, patch: Partial<Message> = {}): Message {
  return {
    id: uuid(1000 + seq),
    conversationId: uuid(500),
    seq,
    changeSeq: seq,
    kind: 'user',
    status: 'sent',
    senderId: uuid(1),
    body: `message ${seq}`,
    replyTo: null,
    attachments: [],
    mentions: [],
    streamRevision: 0,
    editedAt: null,
    recalledAt: null,
    deletedAt: null,
    createdAt: ISO,
    meta: {},
    ...patch,
  }
}

export const recalled = (message: Message, changeSeq: number): Message => ({
  ...message,
  changeSeq,
  body: null,
  recalledAt: ISO,
})

export const edited = (message: Message, changeSeq: number, body: string): Message => ({
  ...message,
  changeSeq,
  body,
  editedAt: ISO,
})

export function makeMe(patch: Partial<ConversationMe> = {}): ConversationMe {
  return {
    version: 1,
    role: 'member',
    membershipId: uuid(700),
    joinedAt: ISO,
    visibleFromSeq: 0,
    lastReadSeq: 0,
    unread: 0,
    notifyLevel: 'all',
    mute: { mode: 'off' },
    silencedUntil: null,
    pinnedAt: null,
    hiddenAt: null,
    ...patch,
  }
}

export function makeConversation(
  n: number,
  patch: Partial<Omit<Conversation, 'me'>> & { me?: ConversationMe | null } = {},
): Conversation {
  const { me = makeMe(), ...rest } = patch
  return {
    id: uuid(n),
    kind: 'group',
    name: `Conversation ${n}`,
    description: null,
    avatarUrl: null,
    metadataVersion: 1,
    membershipVersion: 1,
    viewerVersion: me?.version ?? 0,
    memberCount: 2,
    lastSeq: 0,
    lastChangeSeq: 0,
    lastMessageAt: null,
    lastMessagePreview: null,
    dmPeer: null,
    settings: {},
    panelForConversationId: null,
    agentPurpose: null,
    archivedAt: null,
    previewVersion: { lastChangeSeq: 0, viewerVersion: me?.version ?? 0 },
    me,
    ...rest,
  }
}

export function makeAccount(patch: Partial<Me> = {}): Me {
  return {
    ...makeUser(1),
    meVersion: 1,
    authEpoch: 1,
    restoreEpoch: 'r1',
    email: 'user1@example.test',
    role: 'user',
    bio: null,
    locale: 'en',
    timezone: 'UTC',
    settings: {},
    inviteQuota: 5,
    invitesUsed: 0,
    storageUsedBytes: 0,
    storageQuotaBytes: 1,
    aiDailyTokens: 0,
    ...patch,
  }
}

/** Messages `from` to `to` inclusive, ascending. */
export const run = (from: number, to: number, patch: Partial<Message> = {}): Message[] =>
  Array.from({ length: to - from + 1 }, (_, i) => makeMessage(from + i, patch))
