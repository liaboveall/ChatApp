/**
 * What domain services receive. The domain never reads the environment or the clock directly and never touches
 * Bun, HTTP or the auth SDK; the composition roots (api.ts, worker.ts, cli.ts) build this object.
 */
import type { Db } from '@chatapp/db'
import type { Clock } from '../lib/clock.ts'
import type { Logger } from '../lib/logger.ts'

export type DomainConfig = {
  /** Site origin used in links sent by email. */
  origin: string
  timezone: string
  auth: {
    /** 32 raw bytes encrypting one-time credentials awaiting delivery. */
    tokenEncryptionKey: Uint8Array
    /** Current disaster-recovery generation (RESTORE_EPOCH). */
    restoreEpoch: string
  }
  product: { name: string; agentDisplayName: string; agentUsername: string }
}

/** Hashing is CPU-heavy and belongs to the auth SDK; the domain only sees this port. */
export interface PasswordHasher {
  hash(password: string): Promise<string>
  verify(hash: string, password: string): Promise<boolean>
}

export type Deps = {
  db: Db
  clock: Clock
  newId: () => string
  config: DomainConfig
  passwords: PasswordHasher
  log: Logger
}
