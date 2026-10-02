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

  // Per-user defaults that administrators may override per person (docs/01 section 7).
  defaultStorageQuotaBytes: 5 * 1024 * MiB,
  defaultAiDailyTokens: 500_000,
  /** Abuse guard: live (unexpired, unrevoked) invitations a non-administrator may hold. */
  maxLiveInvitesPerMember: 20,

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
