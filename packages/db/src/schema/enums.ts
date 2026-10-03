/** PostgreSQL enums, each built from the tuple exported by @chatapp/contracts (single source of truth). */
import {
  ACCOUNT_SOURCES,
  ACTIVATION_STATUSES,
  CHALLENGE_PURPOSES,
  CONVERSATION_CHANGE_KINDS,
  CONVERSATION_KINDS,
  CONVERSATION_STATES,
  DELEGATION_PURPOSES,
  DELEGATION_STATUSES,
  EXECUTION_SOURCES,
  IDEMPOTENCY_STATES,
  MEMBER_ROLES,
  MESSAGE_KINDS,
  MESSAGE_STATUSES,
  MUTE_MODES,
  NOTIFY_LEVELS,
  ORIGIN_REVOKE_REASONS,
  PRIVACY_CLASSES,
  REGISTRATION_STATUSES,
  USER_CHANGE_ENTITIES,
  USER_CHANGE_OPERATIONS,
  USER_ROLES,
  WORK_KINDS,
  WORK_STATUSES,
} from '@chatapp/contracts'
import { pgEnum } from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', USER_ROLES)
export const activationStatus = pgEnum('activation_status', ACTIVATION_STATUSES)
export const accountSource = pgEnum('account_source', ACCOUNT_SOURCES)
export const registrationStatus = pgEnum('registration_status', REGISTRATION_STATUSES)
export const challengePurpose = pgEnum('challenge_purpose', CHALLENGE_PURPOSES)
export const originRevokeReason = pgEnum('origin_revoke_reason', ORIGIN_REVOKE_REASONS)
export const delegationPurpose = pgEnum('delegation_purpose', DELEGATION_PURPOSES)
export const delegationStatus = pgEnum('delegation_status', DELEGATION_STATUSES)
export const workKind = pgEnum('work_kind', WORK_KINDS)
export const workStatus = pgEnum('work_status', WORK_STATUSES)
export const idempotencyState = pgEnum('idempotency_state', IDEMPOTENCY_STATES)

// M2a
export const conversationKind = pgEnum('conversation_kind', CONVERSATION_KINDS)
export const memberRole = pgEnum('member_role', MEMBER_ROLES)
export const notifyLevel = pgEnum('notify_level', NOTIFY_LEVELS)
export const muteMode = pgEnum('mute_mode', MUTE_MODES)
export const messageKind = pgEnum('message_kind', MESSAGE_KINDS)
export const messageStatus = pgEnum('message_status', MESSAGE_STATUSES)
export const executionSource = pgEnum('execution_source', EXECUTION_SOURCES)
export const privacyClass = pgEnum('privacy_class', PRIVACY_CLASSES)
export const conversationState = pgEnum('conversation_state', CONVERSATION_STATES)
export const conversationChangeKind = pgEnum('conversation_change_kind', CONVERSATION_CHANGE_KINDS)
export const userChangeEntity = pgEnum('user_change_entity', USER_CHANGE_ENTITIES)
export const userChangeOperation = pgEnum('user_change_operation', USER_CHANGE_OPERATIONS)
