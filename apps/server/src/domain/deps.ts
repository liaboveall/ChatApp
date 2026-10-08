/**
 * What domain services receive. The domain never reads the environment or the clock directly and never touches
 * Bun, HTTP or the auth SDK; the composition roots (api.ts, worker.ts, cli.ts) build this object.
 */
import type { Db } from '@chatapp/db'
import type { AiConfig } from '../config/ai.ts'
import type { Clock } from '../lib/clock.ts'
import type { Logger } from '../lib/logger.ts'
import type { MediaClient } from '../runtime/media.ts'
import type { BlobStore } from '../storage/port.ts'
import type { AiKeyVerifier } from './ai-keys.ts'

export type DomainConfig = {
  /** Site origin used in links sent by email. */
  origin: string
  timezone: string
  auth: {
    /** 32 raw bytes encrypting one-time credentials awaiting delivery. */
    tokenEncryptionKey: Uint8Array
    /** 32 raw bytes signing pagination cursors (derived from the auth secret, never stored). */
    cursorKey: Uint8Array
    /** Current disaster-recovery generation (RESTORE_EPOCH). */
    restoreEpoch: string
  }
  product: { name: string; agentDisplayName: string; agentUsername: string }
  ai?: Omit<AiConfig, 'apiKey'>
  /** 32 raw bytes encrypting members' own AI keys (AI_KEY_ENCRYPTION_KEY, M5a); absent where keys are not handled. */
  aiKeyEncryptionKey?: Uint8Array
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
  blobs?: BlobStore
  /** Only the worker composition root installs IPC; the API never runs a decoder. */
  media?: MediaClient
  /** API only: checks a member's own key with the provider's free model list before it is stored (M5a). */
  aiKeyVerifier?: AiKeyVerifier
  /** Offline local inference over private IPC, never a remote embedding service. */
  embeddings?: {
    modelVersion: string
    dimension: number
    embed(text: string, purpose: 'query' | 'document'): Promise<number[]>
  }
  /**
   * Crash injection (docs/08 section 4, INV-10): the isolated fault suite pauses a real worker at these points and kills
   * it there. Only the worker of APP_ENV=test installs it, and only when asked to; production never has it.
   */
  faultPoint?: (name: 'effect.before' | 'effect.after') => Promise<void>
}
