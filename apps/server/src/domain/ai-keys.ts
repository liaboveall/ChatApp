/**
 * A member's own DeepSeek key (M5a; docs/06 section 14, docs/04 user_ai_keys, SEC-26, A12, V-17).
 *
 * The key is verified with the provider's free model list before it is stored, then kept only as AES-256-GCM ciphertext
 * authenticated with its owner and revision. It is never returned, logged or put into a prompt; the API holds the
 * plaintext only while saving it, the worker only while calling the fixed DeepSeek endpoint. Replacing or deleting it
 * stops every run pinned to the old revision, and a new private segment starts from a blank context (D-080).
 */
import { type AiKey, AppError, type PutAiKeyRequest } from '@chatapp/contracts'
import { agentRuns, type DbOrTx, type Tx, userAiKeys, users } from '@chatapp/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { CURRENT_KEY_VERSION, open, seal } from '../lib/crypto.ts'
import { closePendingApprovals } from './agent-access.ts'
import { writeAudit } from './audit.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'

/** What the provider said about a key (V-17); the verifier never returns or logs the key or the provider's text. */
export type AiKeyVerdict =
  | { kind: 'valid' }
  | { kind: 'invalid'; reason: 'invalid' | 'insufficient_balance' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'unavailable' }
export type AiKeyVerifier = (key: string) => Promise<AiKeyVerdict>

type KeyRow = typeof userAiKeys.$inferSelect

const aad = (userId: string, revision: number) => `ai-key:${userId}:${revision}`

export function aiKeyDto(row: KeyRow): AiKey {
  return {
    provider: row.provider,
    last4: row.keyLast4,
    status: row.status,
    invalidReason:
      row.invalidReason === 'invalid' || row.invalidReason === 'insufficient_balance'
        ? row.invalidReason
        : null,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Where a new segment's calls go: the person's own key when one is active and they did not choose the site allowance
 * (docs/06 section 14). Existing segments keep the source they were created with.
 */
export async function defaultKeySource(db: DbOrTx, userId: string): Promise<'site' | 'user'> {
  const [row] = await db
    .select({ status: userAiKeys.status, settings: users.settings })
    .from(users)
    .leftJoin(userAiKeys, eq(userAiKeys.userId, users.id))
    .where(eq(users.id, userId))
  if (row?.status !== 'active') return 'site'
  return row.settings.aiKeyPreference === 'site' ? 'site' : 'user'
}

/** The active key's revision, or null; runs pin it at creation and stop when it changes. */
export async function activeKeyRevision(db: DbOrTx, userId: string): Promise<number | null> {
  const [row] = await db
    .select({ revision: userAiKeys.revision, status: userAiKeys.status })
    .from(userAiKeys)
    .where(eq(userAiKeys.userId, userId))
  return row?.status === 'active' ? row.revision : null
}

export async function getAiKey(deps: Deps, principal: SessionPrincipal): Promise<AiKey | null> {
  const [row] = await deps.db
    .select()
    .from(userAiKeys)
    .where(eq(userAiKeys.userId, principal.userId))
  return row ? aiKeyDto(row) : null
}

/** Runs pinned to a key revision that no longer exists cannot continue or fall back to the site key (D-080). */
async function stopOwnKeyRuns(tx: Tx, deps: Pick<Deps, 'clock'>, userId: string): Promise<void> {
  const now = deps.clock.now()
  const stopped = await tx
    .update(agentRuns)
    .set({
      status: 'cancelled',
      cancelRequestedAt: now,
      finishedAt: now,
      pendingApproval: false,
      leaseUntil: null,
      leaseEpoch: sql`${agentRuns.leaseEpoch} + 1`,
      stateVersion: sql`${agentRuns.stateVersion} + 1`,
      errorCode: 'CONTEXT_CHANGED',
      errorMessage: 'The key of this run was replaced or removed',
    })
    .where(
      and(
        eq(agentRuns.userId, userId),
        eq(agentRuns.keySource, 'user'),
        inArray(agentRuns.status, ['queued', 'running', 'awaiting_approval']),
      ),
    )
    .returning({ id: agentRuns.id })
  await closePendingApprovals(
    tx,
    deps,
    stopped.map((r) => r.id),
    'context_changed',
  )
}

function keyError(verdict: Exclude<AiKeyVerdict, { kind: 'valid' }>): AppError {
  switch (verdict.kind) {
    case 'invalid':
      return new AppError('AI_KEY_INVALID', 'The key was not accepted by the provider', {
        details: { reason: verdict.reason },
      })
    case 'rate_limited':
      return new AppError('RATE_LIMITED', 'The provider is limiting requests; try again later', {
        headers: { 'Retry-After': String(verdict.retryAfterSeconds) },
      })
    case 'unavailable':
      return new AppError('CAPACITY_UNAVAILABLE', 'The provider could not be reached', {
        headers: { 'Retry-After': '60' },
      })
  }
}

/**
 * Verifies and stores (or replaces) the key. Verification happens before the transaction, so no lock waits on the
 * network; a key that fails is never stored. The answer shows only the last four characters.
 */
export async function saveAiKey(
  deps: Deps,
  principal: SessionPrincipal,
  input: PutAiKeyRequest,
): Promise<AiKey> {
  const encryptionKey = deps.config.aiKeyEncryptionKey
  if (!deps.aiKeyVerifier || !encryptionKey)
    throw new AppError('CAPACITY_UNAVAILABLE', 'Own keys are not available on this server')
  const key = input.key.trim()
  const verdict = await deps.aiKeyVerifier(key)
  if (verdict.kind !== 'valid') throw keyError(verdict)
  return await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const [next] = await tx.execute<{ revision: string }>(
      sql`select nextval('user_ai_key_revisions') as revision`,
    )
    const revision = Number(next?.revision)
    if (!Number.isSafeInteger(revision)) throw new Error('key revision unavailable')
    const sealed = seal(encryptionKey, key, aad(principal.userId, revision))
    const now = deps.clock.now()
    const values = {
      provider: input.provider,
      keyCiphertext: sealed.ciphertext,
      keyNonce: sealed.nonce,
      keyVersion: sealed.keyVersion,
      revision,
      keyLast4: key.slice(-4),
      status: 'active' as const,
      invalidReason: null,
      lastVerifiedAt: now,
      updatedAt: now,
    }
    const [row] = await tx
      .insert(userAiKeys)
      .values({ userId: principal.userId, createdAt: now, ...values })
      .onConflictDoUpdate({ target: userAiKeys.userId, set: values })
      .returning()
    if (!row) throw new Error('key was not stored')
    await stopOwnKeyRuns(tx, deps, principal.userId)
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'ai_key.saved',
      targetType: 'user',
      targetId: principal.userId,
      metadata: { provider: input.provider, revision },
    })
    return aiKeyDto(row)
  })
}

export async function deleteAiKey(deps: Deps, principal: SessionPrincipal): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const removed = await tx
      .delete(userAiKeys)
      .where(eq(userAiKeys.userId, principal.userId))
      .returning({ revision: userAiKeys.revision })
    await stopOwnKeyRuns(tx, deps, principal.userId)
    if (removed.length)
      await writeAudit(tx, {
        actorId: principal.userId,
        action: 'ai_key.deleted',
        targetType: 'user',
        targetId: principal.userId,
      })
  })
}

/**
 * The plaintext key of a run, for the worker's model call only. A replaced, removed or invalid key ends the run instead
 * of silently using another source.
 */
export async function runKey(
  deps: Pick<Deps, 'db' | 'config'>,
  run: { userId: string; keyRevision: number | null },
): Promise<string> {
  const encryptionKey = deps.config.aiKeyEncryptionKey
  if (!encryptionKey) throw new AppError('CAPACITY_UNAVAILABLE', 'Own keys are not available')
  const [row] = await deps.db.select().from(userAiKeys).where(eq(userAiKeys.userId, run.userId))
  if (!row || row.revision !== run.keyRevision)
    throw new AppError('CONTEXT_CHANGED', 'The key of this run was replaced or removed')
  if (row.status !== 'active')
    throw new AppError('AI_KEY_INVALID', 'The key is no longer accepted', {
      details: { reason: row.invalidReason ?? 'invalid' },
    })
  if (row.keyVersion !== CURRENT_KEY_VERSION) throw new Error('unknown key encryption version')
  return open(
    encryptionKey,
    { ciphertext: row.keyCiphertext, nonce: row.keyNonce },
    aad(row.userId, row.revision),
  )
}

/** The provider rejected the key during a run: mark exactly that revision; rate limiting never marks a key (V-17). */
export async function markKeyRejected(
  deps: Pick<Deps, 'db' | 'clock'>,
  userId: string,
  revision: number | null,
  reason: 'invalid' | 'insufficient_balance',
): Promise<void> {
  if (revision === null) return
  await deps.db
    .update(userAiKeys)
    .set({ status: 'invalid', invalidReason: reason, updatedAt: deps.clock.now() })
    .where(and(eq(userAiKeys.userId, userId), eq(userAiKeys.revision, revision)))
}
