/**
 * Enumerations shared by the database (as PostgreSQL enums of the same name) and the API.
 * Each tuple is the single source of truth; the zod enum is exported next to it (docs/04 conventions).
 */
import { z } from 'zod'

export const USER_ROLES = ['user', 'admin'] as const
export const userRoleSchema = z.enum(USER_ROLES)
export type UserRole = z.infer<typeof userRoleSchema>

/** Login requires `active` and a verified email (INV-18). */
export const ACTIVATION_STATUSES = ['pending', 'active', 'revoked'] as const
export const activationStatusSchema = z.enum(ACTIVATION_STATUSES)
export type ActivationStatus = z.infer<typeof activationStatusSchema>

/** How an account came to exist; only `registration` goes through an invitation (INV-18). */
export const ACCOUNT_SOURCES = ['registration', 'cli', 'bootstrap'] as const
export const accountSourceSchema = z.enum(ACCOUNT_SOURCES)
export type AccountSource = z.infer<typeof accountSourceSchema>

/** Registration state machine (D-059). */
export const REGISTRATION_STATUSES = [
  'reserved',
  'account_created',
  'confirmed',
  'released',
] as const
export const registrationStatusSchema = z.enum(REGISTRATION_STATUSES)
export type RegistrationStatus = z.infer<typeof registrationStatusSchema>

/** Purpose of an opaque one-time credential (D-076). */
export const CHALLENGE_PURPOSES = ['verify_email', 'reset_password'] as const
export const challengePurposeSchema = z.enum(CHALLENGE_PURPOSES)
export type ChallengePurpose = z.infer<typeof challengePurposeSchema>

/** Why an authorization origin was revoked; a plain sign-out only sets ended_at (docs/03 section 5.9). */
export const ORIGIN_REVOKE_REASONS = [
  'device_revoked',
  'other_devices_revoked',
  'all_devices_revoked',
  'password_changed',
  'password_reset',
  'banned',
  'account_deleted',
  'registration_cleanup',
  'restore',
] as const
export const originRevokeReasonSchema = z.enum(ORIGIN_REVOKE_REASONS)
export type OriginRevokeReason = z.infer<typeof originRevokeReasonSchema>

export const DELEGATION_PURPOSES = ['agent_run', 'reminder', 'scheduled_message'] as const
export const delegationPurposeSchema = z.enum(DELEGATION_PURPOSES)
export type DelegationPurpose = z.infer<typeof delegationPurposeSchema>

export const DELEGATION_STATUSES = ['active', 'revoked', 'completed', 'expired'] as const
export const delegationStatusSchema = z.enum(DELEGATION_STATUSES)
export type DelegationStatus = z.infer<typeof delegationStatusSchema>

/** Durable work intents; later milestones append kinds (media, push, agent, ...). */
export const WORK_KINDS = ['realtime', 'email'] as const
export const workKindSchema = z.enum(WORK_KINDS)
export type WorkKind = z.infer<typeof workKindSchema>

export const WORK_STATUSES = [
  'pending',
  'leased',
  'running',
  'retry',
  'done',
  'dead',
  'uncertain',
] as const
export const workStatusSchema = z.enum(WORK_STATUSES)
export type WorkStatus = z.infer<typeof workStatusSchema>

export const IDEMPOTENCY_STATES = ['pending', 'completed'] as const
export const idempotencyStateSchema = z.enum(IDEMPOTENCY_STATES)
export type IdempotencyState = z.infer<typeof idempotencyStateSchema>

// ───────── Conversations and messages (M2a, docs/04 sections 2 and 3) ─────────

/** `agent` conversations arrive with M4; the enum carries it from the start so the column never needs rewriting. */
export const CONVERSATION_KINDS = ['channel', 'group', 'dm', 'agent'] as const
export const conversationKindSchema = z.enum(CONVERSATION_KINDS)
export type ConversationKind = z.infer<typeof conversationKindSchema>

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const
export const memberRoleSchema = z.enum(MEMBER_ROLES)
export type MemberRole = z.infer<typeof memberRoleSchema>

export const NOTIFY_LEVELS = ['all', 'mentions', 'none'] as const
export const notifyLevelSchema = z.enum(NOTIFY_LEVELS)
export type NotifyLevel = z.infer<typeof notifyLevelSchema>

/** Permanent mute is its own state, never an infinite date (D-088). Only `until` carries a finite `muted_until`. */
export const MUTE_MODES = ['off', 'until', 'forever'] as const
export const muteModeSchema = z.enum(MUTE_MODES)
export type MuteMode = z.infer<typeof muteModeSchema>

export const MESSAGE_KINDS = ['user', 'system', 'agent'] as const
export const messageKindSchema = z.enum(MESSAGE_KINDS)
export type MessageKind = z.infer<typeof messageKindSchema>

export const MESSAGE_STATUSES = ['sent', 'streaming', 'failed'] as const
export const messageStatusSchema = z.enum(MESSAGE_STATUSES)
export type MessageStatus = z.infer<typeof messageStatusSchema>

/** Set by the trusted entry point, never by the client; only `interactive` advances a person's read position (D-083). */
export const EXECUTION_SOURCES = [
  'interactive',
  'offline_replay',
  'agent_effect',
  'scheduled',
  'system',
] as const
export const executionSourceSchema = z.enum(EXECUTION_SOURCES)
export type ExecutionSource = z.infer<typeof executionSourceSchema>

export const PRIVACY_CLASSES = ['standard', 'byok_private'] as const
export const privacyClassSchema = z.enum(PRIVACY_CLASSES)
export type PrivacyClass = z.infer<typeof privacyClassSchema>

/**
 * Per-user relation to a conversation (docs/04 user_conversation_states). `archived` is reserved: archiving is shared
 * metadata on the conversation itself and is derived for every member (D-125), so nothing writes it yet.
 */
export const CONVERSATION_STATES = ['active', 'hidden', 'archived', 'removed'] as const
export const conversationStateSchema = z.enum(CONVERSATION_STATES)
export type ConversationState = z.infer<typeof conversationStateSchema>

/** What a conversation_changes row says happened to its message; the log never holds content. */
export const CONVERSATION_CHANGE_KINDS = [
  'message_created',
  'message_edited',
  'message_recalled',
  'message_deleted',
] as const
export const conversationChangeKindSchema = z.enum(CONVERSATION_CHANGE_KINDS)
export type ConversationChangeKind = z.infer<typeof conversationChangeKindSchema>

/** Entities a user_changes row can point at; the sync feed returns the current authorized state of each. */
export const USER_CHANGE_ENTITIES = ['conversation', 'message_hidden', 'me'] as const
export const userChangeEntitySchema = z.enum(USER_CHANGE_ENTITIES)
export type UserChangeEntity = z.infer<typeof userChangeEntitySchema>

export const USER_CHANGE_OPERATIONS = ['upsert', 'remove'] as const
export const userChangeOperationSchema = z.enum(USER_CHANGE_OPERATIONS)
export type UserChangeOperation = z.infer<typeof userChangeOperationSchema>

export const PRESENCE_STATUSES = ['online', 'away', 'offline'] as const
export const presenceStatusSchema = z.enum(PRESENCE_STATUSES)
export type PresenceStatus = z.infer<typeof presenceStatusSchema>
