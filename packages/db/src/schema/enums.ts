/** PostgreSQL enums, each built from the tuple exported by @chatapp/contracts (single source of truth). */
import {
  ACCOUNT_SOURCES,
  ACTIVATION_STATUSES,
  CHALLENGE_PURPOSES,
  DELEGATION_PURPOSES,
  DELEGATION_STATUSES,
  IDEMPOTENCY_STATES,
  ORIGIN_REVOKE_REASONS,
  REGISTRATION_STATUSES,
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
