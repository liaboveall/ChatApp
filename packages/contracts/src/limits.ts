/** Numeric limits shared by client and server (docs/01 section 7, docs/05, docs/07). */

const KiB = 1024
const MiB = 1024 * KiB

export const LIMITS = {
  // Request budgets, enforced before parsing (D-078).
  jsonBodyBytes: 128 * KiB,
  monitoringBodyBytes: 256 * KiB,
  uploadBodyBytes: 100 * MiB,
  jsonReadTotalMs: 15_000,
  jsonReadIdleMs: 5_000,
  uploadReadTotalMs: 120_000,
  uploadReadIdleMs: 15_000,

  // WebSocket (docs/05 section 4.1, docs/03 section 6).
  wsFrameBytes: 64 * KiB,
  wsMaxConnectionsPerUser: 10,
  wsHeartbeatMs: 25_000,
  wsPongTimeoutMs: 60_000,
  wsRevalidateMs: 5_000,
  wsSendBufferBytes: 256 * KiB,

  // Identity fields.
  passwordMinLength: 10,
  passwordMaxLength: 128,
  usernameMinLength: 3,
  usernameMaxLength: 20,
  displayNameMaxGraphemes: 32,
  /** Hard cap on UTF-16 code units so a 32-grapheme name cannot be arbitrarily large. */
  displayNameMaxCodeUnits: 160,
  bioMaxLength: 200,
  emailMaxLength: 254,

  // Invitations (docs/01 section 4.2).
  inviteCodeLength: 16,
  inviteDefaultTtlDays: 7,
  inviteDefaultMaxUses: 1,
  inviteNoteMaxLength: 100,
  inviteQuotaDefault: 5,

  /** A username can change once in this many days, and the name given up stays reserved for as long (docs/01 section 4.3). */
  usernameChangeCooldownDays: 30,
  usernameReserveDays: 30,

  // Per-user defaults that administrators may override per person (docs/01 section 7).
  defaultStorageQuotaBytes: 5 * 1024 * MiB,
  defaultAiDailyTokens: 500_000,
  /** Abuse guard: live (unexpired, unrevoked) invitations a non-administrator may hold. */
  maxLiveInvitesPerMember: 20,

  // Conversations (docs/01 sections 4.4 and 7). Member limits and counts the administrator may change are constants
  // until M7 adds app_settings.
  conversationNameMaxGraphemes: 50,
  conversationNameMaxCodeUnits: 200,
  conversationDescriptionMaxLength: 500,
  groupMemberLimit: 500,
  channelMemberLimit: 5000,
  /** Conversations (channels, groups, direct messages) one person can be in at the same time. */
  maxConversationsPerUser: 200,
  /** People added in one request, and people named when a conversation is created. */
  addMembersMax: 100,
  conversationInviteDefaultTtlDays: 7,
  conversationInviteMaxTtlDays: 90,
  conversationInviteMaxUses: 10_000,
  /** Abuse guard: live invitation links one member may hold in one conversation. */
  maxLiveConversationInvitesPerMember: 10,
  maxMuteDays: 366,

  // Messages (docs/01 sections 4.5 and 7).
  messageMaxCodePoints: 5000,
  agentMessageMaxCodePoints: 20_000,
  messageEditWindowMs: 24 * 60 * 60 * 1000,
  messageRecallWindowMs: 2 * 60 * 1000,
  /** Added on the server only, to absorb network delay; the client shows the plain two minutes. */
  messageRecallGraceMs: 5_000,
  messagePageDefault: 50,
  messagePageMax: 100,
  /** Characters of a message shown in a reply quote and in the conversation list preview. */
  excerptMaxCodePoints: 100,
  /** Messages and sends per person (docs/01 section 7); the second one counts every conversation together. */
  messageRateConversationLimit: 10,
  messageRateConversationWindowMs: 10_000,
  messageRateUserLimit: 60,
  messageRateUserWindowMs: 60_000,

  // Sync logs (docs/05 section 4.5, docs/03 section 5.2).
  changeLogRetentionDays: 7,
  changesPageMax: 100,
  changesPageDefault: 100,
  /** A client further behind than this many log entries rebuilds from a snapshot instead of paging. */
  changesResetGap: 1000,
  changesCursorTtlMs: 10 * 60 * 1000,
  /** Tombstones of left conversations outlive every cursor that could still refer to them. */
  removedStateRetentionDays: 7,
  membersPageDefault: 50,
  membersPageMax: 100,
  channelsPageDefault: 20,
  channelsPageMax: 50,
  userSearchMax: 20,
  userSearchQueryMaxLength: 64,

  // Realtime (docs/01 section 4.7, docs/05 section 4.3).
  typingMinIntervalMs: 3_000,
  typingExpiresMs: 5_000,
  presenceWatchMax: 200,

  // Sessions and credentials.
  sessionTtlDays: 30,
  sessionRefreshAgeDays: 1,
  authChallengeTtlMs: 60 * 60 * 1000,
  registrationReservationTtlMs: 10 * 60 * 1000,
  unverifiedAccountTtlDays: 7,
  releasedRegistrationRetentionDays: 30,
  authChallengeMetadataRetentionDays: 7,
  idempotencyKeyTtlHours: 24,
  idempotencyKeyMaxLength: 128,
} as const
