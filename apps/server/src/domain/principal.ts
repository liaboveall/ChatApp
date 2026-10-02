/**
 * Who is acting (docs/03 section 5.9, D-079). Principals are built by the server from a verified session or a stored
 * delegation, never from request input. Domain write functions take a principal and re-validate it inside their
 * transaction; a bare user id is never an execution credential.
 */
import type { UserRole } from '@chatapp/contracts'

export type SessionPrincipal = {
  kind: 'session'
  userId: string
  sessionId: string
  /** The login/device this session belongs to; security revocation works on origins. */
  originId: string
  authEpoch: number
  restoreEpoch: string
  role: UserRole
}

/** Background work acting for a user under a stored delegation (used from M4/M5a). */
export type DelegatedPrincipal = {
  kind: 'delegated'
  userId: string
  delegationId: string
  originId: string
  authEpoch: number
  restoreEpoch: string
  role: UserRole
}

/** Maintenance jobs with a fixed list of allowed actions; it cannot send messages on behalf of anyone. */
export type SystemPrincipal = {
  kind: 'system'
  task: 'cleanup' | 'reconcile' | 'delivery' | 'bootstrap' | 'cli'
}

export type Principal = SessionPrincipal | DelegatedPrincipal | SystemPrincipal
