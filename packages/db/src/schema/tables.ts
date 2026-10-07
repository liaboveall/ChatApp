/**
 * M1a tables (docs/04 sections 1 and 11) and M2a tables (sections 2 and 3). Property names are camelCase; the connection
 * and drizzle-kit use `casing: 'snake_case'`, so columns are snake_case. Better Auth reads and writes the property names,
 * so the auth tables below must keep exactly the field names its schema declares (checked by a conformance test).
 *
 * All tables live in one module because users, sessions, origins and registrations reference each other.
 */
import type { ConversationSettings, MessageMeta } from '@chatapp/contracts'
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  accountSource,
  activationStatus,
  challengePurpose,
  conversationChangeKind,
  conversationKind,
  conversationState,
  delegationPurpose,
  delegationStatus,
  executionSource,
  idempotencyState,
  memberRole,
  messageKind,
  messageStatus,
  muteMode,
  notifyLevel,
  originRevokeReason,
  privacyClass,
  registrationStatus,
  userChangeEntity,
  userChangeOperation,
  userRole,
  workKind,
  workStatus,
} from './enums.ts'
import { jsonbValue } from './json.ts'

const id = () => uuid().primaryKey().default(sql`uuidv7()`)
const ts = () => timestamp({ withTimezone: true })
const createdAt = () => ts().notNull().defaultNow()
const updatedAt = () =>
  ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
const counter = () => bigint({ mode: 'number' }).notNull().default(0)

// ───────────────────────── users and Better Auth tables ─────────────────────────

export const users = pgTable(
  'users',
  {
    id: id(),
    name: text().notNull(),
    email: text().notNull().unique('users_email_unique'),
    emailVerified: boolean().notNull().default(false),
    image: text(),
    username: text().notNull().unique('users_username_unique'),
    role: userRole().notNull().default('user'),
    banned: boolean().notNull().default(false),
    banReason: text(),
    banExpires: ts(),
    /** First-INSERT link to the registration that created the account (D-059); null for bootstrap/CLI accounts. */
    registrationId: uuid()
      .unique('users_registration_id_unique')
      .references((): AnyPgColumn => registrationInviteUses.id),
    activationStatus: activationStatus().notNull().default('pending'),
    /** Ordinary accounts come from an invitation; CLI/bootstrap accounts are the audited exceptions (INV-18). */
    accountSource: accountSource().notNull().default('registration'),
    authEpoch: counter(),
    userChangeSeq: counter(),
    /** Entries of user_changes up to this number were purged (retention); a client behind it must rebuild (D-126). */
    changeLogFloor: counter(),
    profileVersion: bigint({ mode: 'number' }).notNull().default(1),
    meVersion: bigint({ mode: 'number' }).notNull().default(1),
    avatarAttachmentId: uuid().references((): AnyPgColumn => attachments.id),
    isBot: boolean().notNull().default(false),
    bio: text(),
    inviteQuota: integer().notNull().default(5),
    invitesUsed: integer().notNull().default(0),
    invitedById: uuid().references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    usernameChangedAt: ts(),
    storageUsedBytes: counter(),
    storageReservedBytes: counter(),
    storageQuotaBytes: bigint({ mode: 'number' }),
    aiDailyTokens: integer(),
    locale: text().notNull().default('zh-CN'),
    timezone: text().notNull().default('Asia/Shanghai'),
    lastSeenAt: ts(),
    settings: jsonbValue<Record<string, unknown>>().notNull().default({}),
    deletedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('users_email_lower', sql`${t.email} = lower(${t.email})`),
    check('users_username_format', sql`${t.username} ~ '^[a-z0-9_]{3,20}$'`),
    check('users_name_length', sql`char_length(${t.name}) between 1 and 160`),
    check('users_bio_length', sql`${t.bio} is null or char_length(${t.bio}) <= 200`),
    check(
      'users_invites_used_range',
      sql`${t.invitesUsed} >= 0 and (${t.role} = 'admin' or ${t.invitesUsed} <= ${t.inviteQuota})`,
    ),
    check('users_invite_quota_nonneg', sql`${t.inviteQuota} >= 0`),
    check(
      'users_storage_nonneg',
      sql`${t.storageUsedBytes} >= 0 and ${t.storageReservedBytes} >= 0 and (${t.storageQuotaBytes} is null or ${t.storageQuotaBytes} >= 0)`,
    ),
    check('users_epochs_nonneg', sql`${t.authEpoch} >= 0 and ${t.userChangeSeq} >= 0`),
    check(
      'users_change_floor_range',
      sql`${t.changeLogFloor} >= 0 and ${t.changeLogFloor} <= ${t.userChangeSeq}`,
    ),
    // INV-18: an active account has a verified email; only registrations carry a registration_id, from the first INSERT.
    check(
      'users_active_needs_verified_email',
      sql`${t.activationStatus} <> 'active' or ${t.emailVerified}`,
    ),
    check(
      'users_registration_link',
      sql`(${t.accountSource} = 'registration') = (${t.registrationId} is not null)`,
    ),
    index('users_invited_by_idx').on(t.invitedById),
    // Cleanup of unverified accounts scans pending rows by age.
    index('users_pending_created_idx')
      .on(t.createdAt)
      .where(sql`${t.activationStatus} = 'pending'`),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text().notNull().unique('sessions_token_unique'),
    expiresAt: ts().notNull(),
    ipAddress: text(),
    userAgent: text(),
    /** users.auth_epoch at login; a session whose epoch differs from the user's is dead (docs/03 section 5.8). */
    authEpoch: bigint({ mode: 'number' }).notNull(),
    /** Device/login origin created by the server at login, never chosen by the client (D-079). */
    authorizationOriginId: uuid()
      .notNull()
      .references((): AnyPgColumn => authorizationOrigins.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_origin_idx').on(t.authorizationOriginId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
)

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accountId: text().notNull(),
    providerId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: ts(),
    refreshTokenExpiresAt: ts(),
    scope: text(),
    /** scrypt hash for providerId = 'credential'. */
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('accounts_provider_account_uidx').on(t.providerId, t.accountId),
    uniqueIndex('accounts_credential_user_uidx')
      .on(t.userId)
      .where(sql`${t.providerId} = 'credential'`),
    index('accounts_user_idx').on(t.userId),
  ],
)

/** Only used by the SDK for passkey ceremony state; email verification and reset use auth_challenges. */
export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: ts().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('verifications_identifier_idx').on(t.identifier),
    index('verifications_expires_idx').on(t.expiresAt),
  ],
)

export const passkeys = pgTable(
  'passkeys',
  {
    id: id(),
    name: text(),
    publicKey: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Explicit column name: the SDK's property is credentialID, which snake_case would turn into credential_i_d.
    credentialID: text('credential_id').notNull().unique('passkeys_credential_id_unique'),
    counter: integer().notNull(),
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    createdAt: ts().defaultNow(),
    aaguid: text(),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
)

// ───────────────────────── identity foundation (D-076, D-079) ─────────────────────────

export const authorizationOrigins = pgTable(
  'authorization_origins',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** RESTORE_EPOCH at login; after a disaster restore the value changes and every origin becomes invalid. */
    restoreEpoch: text().notNull(),
    createdAt: createdAt(),
    /** Plain sign-out or expiry: the session ends but delegated work continues. */
    endedAt: ts(),
    /** Security revocation: all work started from this origin is cancelled. */
    revokedAt: ts(),
    revokeReason: originRevokeReason(),
  },
  (t) => [
    check('origins_revoke_pair', sql`(${t.revokedAt} is null) = (${t.revokeReason} is null)`),
    index('origins_user_idx').on(t.userId),
  ],
)

export const executionDelegations = pgTable(
  'execution_delegations',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    originId: uuid()
      .notNull()
      .references(() => authorizationOrigins.id),
    parentId: uuid().references((): AnyPgColumn => executionDelegations.id, {
      onDelete: 'set null',
    }),
    authEpoch: bigint({ mode: 'number' }).notNull(),
    restoreEpoch: text().notNull(),
    purpose: delegationPurpose().notNull(),
    targetType: text(),
    targetId: uuid(),
    argsHash: text(),
    status: delegationStatus().notNull().default('active'),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'delegations_revoked_has_time',
      sql`${t.status} <> 'revoked' or ${t.revokedAt} is not null`,
    ),
    index('delegations_user_status_idx').on(t.userId, t.status),
    index('delegations_origin_status_idx').on(t.originId, t.status),
    index('delegations_active_expiry_idx').on(t.expiresAt).where(sql`${t.status} = 'active'`),
  ],
)

export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Required for ordinary registrations; null only for audited bootstrap/CLI accounts. */
    registrationId: uuid().references((): AnyPgColumn => registrationInviteUses.id, {
      onDelete: 'set null',
    }),
    purpose: challengePurpose().notNull(),
    /** SHA-256 of the normalized email the credential was issued for; a later email change invalidates it. */
    emailHash: text().notNull(),
    authEpoch: bigint({ mode: 'number' }).notNull(),
    restoreEpoch: text().notNull(),
    /** SHA-256 of the 256-bit random token; the token itself exists only in the email. */
    tokenHash: text().notNull().unique('auth_challenges_token_hash_unique'),
    expiresAt: ts().notNull(),
    consumedAt: ts(),
    revokedAt: ts(),
    /** Token encrypted for the email worker with AUTH_TOKEN_ENCRYPTION_KEY; cleared after sending/expiry/revoke. */
    deliveryCiphertext: text(),
    deliveryNonce: text(),
    deliveryKeyVersion: smallint(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'challenges_single_end',
      sql`not (${t.consumedAt} is not null and ${t.revokedAt} is not null)`,
    ),
    check(
      'challenges_delivery_all_or_none',
      sql`(${t.deliveryCiphertext} is null) = (${t.deliveryNonce} is null) and (${t.deliveryCiphertext} is null) = (${t.deliveryKeyVersion} is null)`,
    ),
    // At most one live credential per user and purpose: resending revokes the previous one first.
    uniqueIndex('challenges_one_live_uidx')
      .on(t.userId, t.purpose)
      .where(sql`${t.consumedAt} is null and ${t.revokedAt} is null`),
    index('challenges_user_idx').on(t.userId),
    index('challenges_expires_idx').on(t.expiresAt),
  ],
)

// ───────────────────────── registration state machine (D-059) ─────────────────────────

export const usernameReservations = pgTable(
  'username_reservations',
  {
    username: text().primaryKey(),
    /** The previous owner; null for system-reserved names. */
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /** null = reserved forever. */
    reservedUntil: ts(),
  },
  (t) => [check('username_reservations_lower', sql`${t.username} = lower(${t.username})`)],
)

export const registrationInvites = pgTable(
  'registration_invites',
  {
    id: id(),
    /** SHA-256 of the 16-character base32 code; the plaintext is shown once, at creation. */
    codeHash: text().notNull().unique('registration_invites_code_hash_unique'),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    note: text(),
    /** null = unlimited (site administrators only). */
    maxUses: integer(),
    useCount: integer().notNull().default(0),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'invites_use_count_range',
      sql`${t.useCount} >= 0 and (${t.maxUses} is null or ${t.useCount} <= ${t.maxUses})`,
    ),
    check('invites_max_uses_positive', sql`${t.maxUses} is null or ${t.maxUses} >= 1`),
    index('invites_created_by_idx').on(t.createdBy),
  ],
)

export const registrationInviteUses = pgTable(
  'registration_invite_uses',
  {
    /** The stable registration_id. */
    id: id(),
    inviteId: uuid()
      .notNull()
      .references(() => registrationInvites.id),
    inviterId: uuid()
      .notNull()
      .references(() => users.id),
    /** Mirror of users.registration_id; both are set in the same transaction as the account INSERT. */
    userId: uuid()
      .unique('registration_invite_uses_user_id_unique')
      .references((): AnyPgColumn => users.id, { onDelete: 'set null' }),
    /** Personal fields: cleared when the registration is released. */
    emailNormalized: text(),
    requestHash: text(),
    status: registrationStatus().notNull().default('reserved'),
    leaseEpoch: counter(),
    leaseUntil: ts(),
    expiresAt: ts().notNull(),
    createdAt: createdAt(),
    confirmedAt: ts(),
    releasedAt: ts(),
  },
  (t) => [
    check(
      'registration_uses_email_kept',
      sql`${t.status} = 'released' or ${t.emailNormalized} is not null`,
    ),
    check('registration_uses_lease_nonneg', sql`${t.leaseEpoch} >= 0`),
    index('registration_uses_invite_idx').on(t.inviteId),
    index('registration_uses_inviter_idx').on(t.inviterId),
    index('registration_uses_open_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} in ('reserved', 'account_created')`),
  ],
)

// ───────────────────────── system tables ─────────────────────────

export const appSettings = pgTable('app_settings', {
  key: text().primaryKey(),
  value: jsonbValue<unknown>().notNull(),
  version: integer().notNull().default(1),
  updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
})

/** Ids and metadata only, never message bodies, tokens or secrets (SEC-21). */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    action: text().notNull(),
    targetType: text(),
    targetId: uuid(),
    metadata: jsonbValue<Record<string, unknown>>().notNull().default({}),
    requestId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_created_idx').on(t.createdAt),
    index('audit_logs_actor_idx').on(t.actorId, t.createdAt),
  ],
)

/** Durable work intents written in the same transaction as the business change (D-056, docs/04 section 11). */
export const workItems = pgTable(
  'work_items',
  {
    id: id(),
    kind: workKind().notNull(),
    dedupeKey: text().notNull().unique('work_items_dedupe_key_unique'),
    entityId: uuid(),
    entityVersion: bigint({ mode: 'number' }),
    /** Identifiers and non-sensitive parameters only; never bodies, tokens or passwords. */
    payload: jsonbValue<Record<string, unknown>>().notNull().default({}),
    status: workStatus().notNull().default('pending'),
    /** Bumped on every redelivery so a retained completed BullMQ job cannot block a new delivery. */
    deliverySeq: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    availableAt: ts().notNull().defaultNow(),
    leaseEpoch: counter(),
    leaseUntil: ts(),
    lastErrorCode: text(),
    createdAt: createdAt(),
    finishedAt: ts(),
  },
  (t) => [
    check(
      'work_items_counters_nonneg',
      sql`${t.deliverySeq} >= 0 and ${t.attempts} >= 0 and ${t.leaseEpoch} >= 0`,
    ),
    index('work_items_ready_idx')
      .on(t.status, t.availableAt)
      .where(sql`${t.status} in ('pending', 'retry')`),
    index('work_items_lease_idx').on(t.leaseUntil).where(sql`${t.status} in ('leased', 'running')`),
    index('work_items_finished_idx').on(t.finishedAt).where(sql`${t.finishedAt} is not null`),
  ],
)

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: id(),
    actorKey: text().notNull(),
    operation: text().notNull(),
    targetKey: text().notNull(),
    key: text().notNull(),
    requestHash: text().notNull(),
    resourceType: text(),
    resourceId: uuid(),
    state: idempotencyState().notNull().default('pending'),
    createdAt: createdAt(),
    expiresAt: ts().notNull(),
  },
  (t) => [
    uniqueIndex('idempotency_scope_uidx').on(t.actorKey, t.operation, t.targetKey, t.key),
    check('idempotency_key_length', sql`char_length(${t.key}) between 1 and 128`),
    index('idempotency_expires_idx').on(t.expiresAt),
  ],
)

// ───────────────────────── conversations (M2a, docs/04 section 2) ─────────────────────────

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    kind: conversationKind().notNull(),
    /** null for direct messages; 1-50 characters otherwise. */
    name: text(),
    description: text(),
    /** Plain id until attachments exist (M3, D-091). */
    avatarAttachmentId: uuid().references((): AnyPgColumn => attachments.id),
    /** Owner of a channel or group (and, for an archived one, who may restore it); the Agent's owner in M4. */
    ownerId: uuid().references(() => users.id, { onDelete: 'set null' }),
    settings: jsonbValue<ConversationSettings>().notNull().default({}),
    /** M4: the conversation an assistant panel is bound to. */
    panelForConversationId: uuid().references((): AnyPgColumn => conversations.id, {
      onDelete: 'cascade',
    }),
    /** Allocators: a new message takes last_seq + 1 and last_change_seq + 1 in one UPDATE (INV-01). */
    lastSeq: counter(),
    lastChangeSeq: counter(),
    /** Name, description, avatar, settings, member count or archive state changed. */
    metadataVersion: bigint({ mode: 'number' }).notNull().default(1),
    /** Members, roles, silences or bans changed. */
    membershipVersion: counter(),
    lastMessageAt: ts(),
    memberCount: integer().notNull().default(0),
    archivedAt: ts(),
    /** conversation_changes entries up to this number were purged (retention); older cursors reset (D-126). */
    changeLogFloor: counter(),
    createdBy: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'conversations_name_by_kind',
      sql`(${t.kind} = 'dm' and ${t.name} is null) or (${t.kind} <> 'dm' and ${t.name} is not null and char_length(${t.name}) between 1 and 200)`,
    ),
    check(
      'conversations_description_length',
      sql`${t.description} is null or char_length(${t.description}) <= 1000`,
    ),
    check('conversations_dm_has_no_owner', sql`${t.kind} <> 'dm' or ${t.ownerId} is null`),
    check(
      'conversations_panel_only_agent',
      sql`${t.panelForConversationId} is null or ${t.kind} = 'agent'`,
    ),
    check(
      'conversations_counters',
      sql`${t.lastSeq} >= 0 and ${t.lastChangeSeq} >= ${t.lastSeq} and ${t.metadataVersion} >= 1 and ${t.membershipVersion} >= 0 and ${t.memberCount} >= 0 and ${t.changeLogFloor} >= 0 and ${t.changeLogFloor} <= ${t.lastChangeSeq}`,
    ),
    // Channel names are unique among live channels, ignoring case and full-width forms (docs/04, L-03). `NFKC` is a
    // keyword of the SQL NORMALIZE syntax, not a string.
    uniqueIndex('conversations_channel_name_uidx')
      .on(sql`lower(normalize(${t.name}, NFKC))`)
      .where(sql`${t.kind} = 'channel' and ${t.archivedAt} is null`),
    index('conversations_kind_archived_idx').on(t.kind, t.archivedAt),
    index('conversations_channel_name_trgm_idx')
      .using('gin', t.name.op('gin_trgm_ops'))
      .where(sql`${t.kind} = 'channel'`),
    uniqueIndex('conversations_panel_uidx')
      .on(t.ownerId, t.panelForConversationId)
      .where(sql`${t.panelForConversationId} is not null`),
    index('conversations_owner_archived_idx').on(t.ownerId).where(sql`${t.archivedAt} is not null`),
  ],
)

/**
 * Append-only log of message changes, one row per change_seq (docs/04, D-056). It holds identifiers and the kind of
 * change, never content; `message_id` has no foreign key so a removed message leaves a tombstone instead of a hole.
 */
export const conversationChanges = pgTable(
  'conversation_changes',
  {
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    changeSeq: bigint({ mode: 'number' }).notNull(),
    messageId: uuid(),
    kind: conversationChangeKind().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.changeSeq] }),
    check('conversation_changes_seq_positive', sql`${t.changeSeq} >= 1`),
    index('conversation_changes_created_idx').on(t.createdAt),
  ],
)

/** The same for one person: memberships, roles, preferences, read position, hidden messages, own profile. */
export const userChanges = pgTable(
  'user_changes',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    changeSeq: bigint({ mode: 'number' }).notNull(),
    entityType: userChangeEntity().notNull(),
    entityId: uuid().notNull(),
    operation: userChangeOperation().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.changeSeq] }),
    check('user_changes_seq_positive', sql`${t.changeSeq} >= 1`),
    index('user_changes_created_idx').on(t.createdAt),
  ],
)

/**
 * A person's relation to a conversation, including the tombstone of one that ended (docs/04, D-082). There is no foreign
 * key to the conversation: the tombstone must outlive it. `viewer_version` is the user_change_seq of the last change.
 */
export const userConversationStates = pgTable(
  'user_conversation_states',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid().notNull(),
    membershipId: uuid(),
    state: conversationState().notNull().default('active'),
    viewerVersion: counter(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.conversationId] }),
    check('user_conversation_states_version_nonneg', sql`${t.viewerVersion} >= 0`),
    index('user_conversation_states_conversation_idx').on(t.conversationId),
    index('user_conversation_states_removed_idx')
      .on(t.updatedAt)
      .where(sql`${t.state} = 'removed'`),
  ],
)

/** One direct message per pair of people (INV-04): the smaller user id is `user_low`. */
export const dmPairs = pgTable(
  'dm_pairs',
  {
    userLow: uuid()
      .notNull()
      .references(() => users.id),
    userHigh: uuid()
      .notNull()
      .references(() => users.id),
    conversationId: uuid()
      .notNull()
      .unique('dm_pairs_conversation_id_unique')
      .references(() => conversations.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.userLow, t.userHigh] }),
    check('dm_pairs_ordered', sql`${t.userLow} < ${t.userHigh}`),
    index('dm_pairs_high_idx').on(t.userHigh),
  ],
)

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRole().notNull().default('member'),
    joinedAt: createdAt(),
    /** New for every join, never reused after leaving (D-082). */
    membershipId: uuid()
      .notNull()
      .unique('conversation_members_membership_id_unique')
      .default(sql`uuidv7()`),
    /** Mirrors user_conversation_states.viewer_version; role and silence changes move it too. */
    stateVersion: counter(),
    /** Messages with seq above this are visible to the member (D-035, INV-09). */
    visibleFromSeq: counter(),
    /** Only moves forward: GREATEST(old, new) (INV-08). */
    lastReadSeq: counter(),
    /** Written by the creating transaction: groups and channels default to mentions, direct messages to all. */
    notifyLevel: notifyLevel().notNull(),
    muteMode: muteMode().notNull().default('off'),
    mutedUntil: ts(),
    /** Cannot send before this time; always finite. */
    silencedUntil: ts(),
    pinnedAt: ts(),
    hiddenAt: ts(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    check(
      'conversation_members_seq_order',
      sql`${t.visibleFromSeq} >= 0 and ${t.lastReadSeq} >= ${t.visibleFromSeq} and ${t.stateVersion} >= 0`,
    ),
    // Only `until` carries a time, and it is always finite (D-088, INV-30).
    check(
      'conversation_members_mute_pair',
      sql`(${t.muteMode} = 'until') = (${t.mutedUntil} is not null)`,
    ),
    index('conversation_members_user_idx').on(t.userId),
    // At most one owner per conversation (INV-23); the deferred trigger in migration 0003 checks that there is one.
    uniqueIndex('conversation_members_one_owner_uidx')
      .on(t.conversationId)
      .where(sql`${t.role} = 'owner'`),
  ],
)

export const conversationBans = pgTable(
  'conversation_bans',
  {
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    bannedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    reason: text(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    check(
      'conversation_bans_reason_length',
      sql`${t.reason} is null or char_length(${t.reason}) <= 400`,
    ),
    index('conversation_bans_user_idx').on(t.userId),
  ],
)

/** Invitation links of a group (docs/01 section 4.2): only the hash of the code is stored. */
export const conversationInvites = pgTable(
  'conversation_invites',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    codeHash: text().notNull().unique('conversation_invites_code_hash_unique'),
    createdBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** null = unlimited. */
    maxUses: integer(),
    useCount: integer().notNull().default(0),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'conversation_invites_use_count_range',
      sql`${t.useCount} >= 0 and (${t.maxUses} is null or ${t.useCount} <= ${t.maxUses})`,
    ),
    check('conversation_invites_max_uses_positive', sql`${t.maxUses} is null or ${t.maxUses} >= 1`),
    index('conversation_invites_conversation_idx').on(t.conversationId),
    index('conversation_invites_creator_idx').on(t.createdBy, t.conversationId),
  ],
)

// ───────────────────────── messages (M2a, docs/04 section 3) ─────────────────────────

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** Assigned at creation and never changed. */
    seq: bigint({ mode: 'number' }).notNull(),
    /** Assigned at the latest change; moves with every edit, recall and deletion (INV-02). */
    changeSeq: bigint({ mode: 'number' }).notNull(),
    /** null for system messages; the bot user for Agent messages. */
    senderId: uuid().references(() => users.id),
    kind: messageKind().notNull(),
    status: messageStatus().notNull().default('sent'),
    /** Markdown; null once recalled or deleted. */
    body: text(),
    replyToId: uuid().references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    /** The sender's stable key for this message and the fingerprint of the first request (INV-03, D-066). */
    clientId: uuid(),
    requestHash: text(),
    /** Body semantics (edits) and streamed snapshots (M4). */
    contentVersion: bigint({ mode: 'number' }).notNull().default(1),
    streamRevision: counter(),
    /** Set by the trusted entry point; only `interactive` moves a person's read position (D-083, INV-28). */
    executionSource: executionSource().notNull(),
    privacyClass: privacyClass().notNull().default('standard'),
    contextEpoch: uuid(),
    meta: jsonbValue<MessageMeta>().notNull().default({}),
    editedAt: ts(),
    recalledAt: ts(),
    deletedAt: ts(),
    deletedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('messages_conversation_seq_uidx').on(t.conversationId, t.seq),
    index('messages_conversation_change_idx').on(t.conversationId, t.changeSeq),
    uniqueIndex('messages_sender_client_uidx')
      .on(t.senderId, t.clientId)
      .where(sql`${t.clientId} is not null`),
    index('messages_reply_to_idx').on(t.replyToId).where(sql`${t.replyToId} is not null`),
    check('messages_sender_unless_system', sql`${t.kind} = 'system' or ${t.senderId} is not null`),
    check('messages_body_length', sql`${t.body} is null or char_length(${t.body}) <= 20000`),
    check('messages_seq_order', sql`${t.seq} >= 1 and ${t.changeSeq} >= ${t.seq}`),
    // A recalled or deleted message keeps no content (INV-06); at most one of the two ends it.
    check(
      'messages_cleared_when_gone',
      sql`(${t.recalledAt} is null and ${t.deletedAt} is null) or ${t.body} is null`,
    ),
    check('messages_one_ending', sql`${t.recalledAt} is null or ${t.deletedAt} is null`),
    check('messages_deleted_by_pair', sql`(${t.deletedAt} is null) = (${t.deletedBy} is null)`),
    check('messages_versions_nonneg', sql`${t.contentVersion} >= 1 and ${t.streamRevision} >= 0`),
  ],
)

/** "Delete for me": a view preference, not a withdrawal of the reader's access (docs/04). */
export const messageHidden = pgTable(
  'message_hidden',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    hiddenAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.messageId] }),
    index('message_hidden_message_idx').on(t.messageId),
  ],
)

// M3: durable reservations and immutable object intents, including failed generations.
export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    uploaderId: uuid()
      .notNull()
      .references(() => users.id),
    conversationId: uuid().references(() => conversations.id),
    messageId: uuid().references(() => messages.id),
    deletedMessageId: uuid(),
    purpose: text().$type<'message' | 'avatar' | 'conversation_avatar'>().notNull(),
    kind: text().$type<'image' | 'video' | 'audio' | 'file'>().notNull().default('file'),
    mime: text().notNull().default('application/octet-stream'),
    originalName: text().notNull(),
    rawSizeBytes: counter(),
    sizeBytes: counter(),
    chargedBytes: counter(),
    sha256: text(),
    generation: bigint({ mode: 'number' }).notNull().default(1),
    version: bigint({ mode: 'number' }).notNull().default(1),
    privacyClass: privacyClass().notNull().default('standard'),
    width: integer(),
    height: integer(),
    durationMs: integer(),
    metadataCleared: boolean(),
    storageKey: text().unique(),
    variants: jsonbValue<
      Record<string, { key: string; w: number | null; h: number | null; mime: string }>
    >()
      .notNull()
      .default({}),
    thumbhash: text(),
    status: text()
      .$type<'uploading' | 'processing' | 'ready' | 'failed' | 'deleting'>()
      .notNull()
      .default('uploading'),
    position: smallint(),
    createdAt: createdAt(),
    deletedAt: ts(),
  },
  (t) => [
    index('attachments_message_idx').on(t.messageId),
    index('attachments_uploader_idx').on(t.uploaderId, t.createdAt),
    index('attachments_status_idx').on(t.status, t.createdAt),
    check(
      'attachments_nonneg',
      sql`${t.rawSizeBytes} >= 0 and ${t.sizeBytes} >= 0 and ${t.chargedBytes} >= 0 and ${t.generation} >= 1 and ${t.version} >= 1`,
    ),
    check('attachments_purpose', sql`${t.purpose} in ('message','avatar','conversation_avatar')`),
    check('attachments_kind', sql`${t.kind} in ('image','video','audio','file')`),
    check(
      'attachments_status',
      sql`${t.status} in ('uploading','processing','ready','failed','deleting')`,
    ),
    check(
      'attachments_ready',
      sql`${t.status} <> 'ready' or (${t.storageKey} is not null and ${t.sha256} ~ '^[0-9a-f]{64}$' and ${t.sizeBytes} > 0 and ${t.chargedBytes} = ${t.sizeBytes})`,
    ),
  ],
)
export const uploadReservations = pgTable(
  'upload_reservations',
  {
    id: id(),
    attachmentId: uuid()
      .notNull()
      .unique()
      .references(() => attachments.id),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    idempotencyKey: text().notNull(),
    requestHash: text().notNull(),
    reservedBytes: counter(),
    siteReservedBytes: counter(),
    maxBytes: bigint({ mode: 'number' }).notNull(),
    status: text()
      .$type<'reserved' | 'uploaded' | 'processing' | 'settled' | 'released'>()
      .notNull()
      .default('reserved'),
    leaseEpoch: counter(),
    expiresAt: ts().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('upload_reservations_user_key').on(t.userId, t.idempotencyKey),
    index('upload_reservations_expiry_idx').on(t.status, t.expiresAt),
    check(
      'upload_reservations_nonneg',
      sql`${t.reservedBytes} >= 0 and ${t.siteReservedBytes} >= 0 and ${t.maxBytes} > 0 and ${t.leaseEpoch} >= 0`,
    ),
    check(
      'upload_reservations_status',
      sql`${t.status} in ('reserved','uploaded','processing','settled','released')`,
    ),
  ],
)
export const attachmentObjects = pgTable(
  'attachment_objects',
  {
    id: id(),
    attachmentId: uuid()
      .notNull()
      .references(() => attachments.id),
    generation: bigint({ mode: 'number' }).notNull(),
    variant: text().notNull(),
    storageKey: text().notNull().unique(),
    sizeBytes: counter(),
    sha256: text(),
    status: text()
      .$type<'staging' | 'live' | 'deleting' | 'deleted'>()
      .notNull()
      .default('staging'),
    accounted: boolean().notNull().default(false),
    deleteAfter: ts(),
    deletedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('attachment_objects_generation_variant').on(
      t.attachmentId,
      t.generation,
      t.variant,
    ),
    index('attachment_objects_delete_idx').on(t.status, t.deleteAfter),
    check('attachment_objects_nonneg', sql`${t.sizeBytes} >= 0 and ${t.generation} >= 1`),
    check('attachment_objects_status', sql`${t.status} in ('staging','live','deleting','deleted')`),
  ],
)
export const siteStorage = pgTable(
  'site_storage',
  {
    id: integer().primaryKey().default(1),
    usedBytes: counter(),
    reservedBytes: counter(),
    budgetBytes: bigint({ mode: 'number' }).notNull().default(53687091200),
    uploadsBlocked: boolean().notNull().default(false),
  },
  (t) => [
    check('site_storage_single', sql`${t.id} = 1`),
    check(
      'site_storage_nonneg',
      sql`${t.usedBytes} >= 0 and ${t.reservedBytes} >= 0 and ${t.budgetBytes} >= 0`,
    ),
  ],
)
export const messageMentions = pgTable(
  'message_mentions',
  {
    messageId: uuid()
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId] }),
    index('message_mentions_user_idx').on(t.userId),
  ],
)
