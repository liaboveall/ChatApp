/**
 * M1a tables (docs/04 sections 1 and 11). Property names are camelCase; the connection and drizzle-kit use
 * `casing: 'snake_case'`, so columns are snake_case. Better Auth reads and writes the property names, so the
 * auth tables below must keep exactly the field names its schema declares (checked by a conformance test).
 *
 * All tables live in one module because users, sessions, origins and registrations reference each other.
 */
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
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
  delegationPurpose,
  delegationStatus,
  idempotencyState,
  originRevokeReason,
  registrationStatus,
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
    profileVersion: bigint({ mode: 'number' }).notNull().default(1),
    meVersion: bigint({ mode: 'number' }).notNull().default(1),
    avatarAttachmentId: uuid(),
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
