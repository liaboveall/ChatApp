/** D-084: authenticated encrypted immutable records, read-back verification, CAS head, and operation-id reconciliation. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import {
  type BackupManifest,
  backupManifestSchema,
  type DeletionIntent,
  deletionIntentSchema,
  type JournalCheckpoint,
  type JournalHead,
  type JournalRecord,
  journalCheckpointSchema,
  journalEnvelopeSchema,
  journalHeadSchema,
  journalRecordSchema,
} from '@chatapp/contracts'
import type { ConditionalStore } from '../storage/conditional.ts'

export const JOURNAL_GENESIS = '0'.repeat(64)
export type JournalAnchor = { seq: number; hash: string }
export type AcceptedDeletion = { record: JournalRecord; hash: string }
export interface DeletionJournal {
  append(input: {
    operationId: string
    actorId: string | null
    intent: DeletionIntent
    acceptedAt: string
    preparedAt?: string
  }): Promise<AcceptedDeletion>
}
export class JournalError extends Error {
  constructor(
    readonly code:
      | 'uninitialized'
      | 'integrity'
      | 'key_missing'
      | 'stale_writer'
      | 'conflict'
      | 'contended',
  ) {
    super(`journal_${code}`)
    this.name = 'JournalError'
  }
}

/** Stable fingerprinting of the allowed identifier-only payload. */
export function deletionFingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export class EncryptedDeletionJournal implements DeletionJournal {
  private readonly headKey: string
  constructor(
    private readonly options: {
      store: ConditionalStore
      prefix: string
      writerEpoch: string
      currentKeyVersion: number
      keys: ReadonlyMap<number, Uint8Array>
      now?: () => Date
    },
  ) {
    if (
      !/^[a-zA-Z0-9_/-]+\/$/.test(options.prefix) ||
      options.prefix.includes('..') ||
      !journalHeadSchema.shape.writerEpoch.safeParse(options.writerEpoch).success
    )
      throw new JournalError('integrity')
    if (options.keys.get(options.currentKeyVersion)?.byteLength !== 32)
      throw new JournalError('key_missing')
    this.headKey = `${options.prefix}head`
  }

  private encrypt(
    kind: 'head' | 'record' | 'checkpoint',
    value: JournalHead | JournalRecord | JournalCheckpoint,
  ): Uint8Array {
    const key = this.options.keys.get(this.options.currentKeyVersion)
    if (!key) throw new JournalError('key_missing')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(`chatapp:deletion-journal:v1:${this.options.prefix}:${kind}`))
    const ciphertext = Buffer.concat([
      cipher.update(canonical(value), 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ])
    return Buffer.from(
      JSON.stringify({
        format: 1,
        keyVersion: this.options.currentKeyVersion,
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      }),
    )
  }
  private decrypt(kind: 'head' | 'record' | 'checkpoint', bytes: Uint8Array): unknown {
    try {
      const envelope = journalEnvelopeSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
      const key = this.options.keys.get(envelope.keyVersion)
      if (!key || key.byteLength !== 32) throw new JournalError('key_missing')
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64url')
      if (ciphertext.byteLength < 16) throw new JournalError('integrity')
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(envelope.nonce, 'base64url'),
      )
      decipher.setAAD(Buffer.from(`chatapp:deletion-journal:v1:${this.options.prefix}:${kind}`))
      decipher.setAuthTag(ciphertext.subarray(-16))
      return JSON.parse(
        Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString(
          'utf8',
        ),
      )
    } catch (error) {
      throw error instanceof JournalError ? error : new JournalError('integrity')
    }
  }
  private recordKey(hash: string): string {
    return `${this.options.prefix}records/${hash}`
  }
  private checkpointKey(hash: string): string {
    return `${this.options.prefix}checkpoints/${hash}`
  }
  private async readCheckpoint(head: JournalHead): Promise<JournalCheckpoint | null> {
    if (!head.checkpoint) return null
    if (head.checkpoint.key !== this.checkpointKey(head.checkpoint.hash))
      throw new JournalError('integrity')
    const object = await this.options.store.read(head.checkpoint.key)
    if (!object || sha(object.bytes) !== head.checkpoint.hash) throw new JournalError('integrity')
    const parsed = journalCheckpointSchema.safeParse(this.decrypt('checkpoint', object.bytes))
    if (
      !parsed.success ||
      parsed.data.floor.seq > head.seq ||
      Date.parse(parsed.data.createdAt) - Date.parse(parsed.data.pruneBefore) < 35 * 86_400_000
    )
      throw new JournalError('integrity')
    return parsed.data
  }
  async head(): Promise<{ head: JournalHead; etag: string }> {
    const result = await this.options.store.read(this.headKey)
    if (!result) throw new JournalError('uninitialized')
    const parsed = journalHeadSchema.safeParse(this.decrypt('head', result.bytes))
    if (!parsed.success) throw new JournalError('integrity')
    const head = parsed.data
    if (
      (head.seq === 0 && (head.hash !== JOURNAL_GENESIS || head.recordKey !== null)) ||
      (head.seq > 0 && head.recordKey !== this.recordKey(head.hash))
    )
      throw new JournalError('integrity')
    await this.readCheckpoint(head)
    return { head, etag: result.etag }
  }
  /** Explicit initialization only. A missing restore head must never be mistaken for an empty deletion history. */
  async initialize(): Promise<void> {
    const head: JournalHead = {
      format: 1,
      writerEpoch: this.options.writerEpoch,
      seq: 0,
      hash: JOURNAL_GENESIS,
      recordKey: null,
    }
    await this.options.store.write(this.headKey, this.encrypt('head', head), { absent: true })
    const existing = await this.head()
    if (existing.head.writerEpoch !== this.options.writerEpoch)
      throw new JournalError('stale_writer')
  }
  async readSince(anchor: JournalAnchor): Promise<AcceptedDeletion[]> {
    return await this.readSinceHead(anchor, (await this.head()).head)
  }
  async floor(): Promise<JournalAnchor> {
    const { head } = await this.head()
    return (await this.readCheckpoint(head))?.floor ?? { seq: 0, hash: JOURNAL_GENESIS }
  }
  private async readSinceHead(
    anchor: JournalAnchor,
    head: JournalHead,
  ): Promise<AcceptedDeletion[]> {
    const checkpoint = await this.readCheckpoint(head)
    if (!Number.isSafeInteger(anchor.seq) || anchor.seq < 0 || !/^[a-f0-9]{64}$/.test(anchor.hash))
      throw new JournalError('integrity')
    if (anchor.seq > head.seq) throw new JournalError('integrity')
    if (
      checkpoint &&
      (anchor.seq < checkpoint.floor.seq ||
        (anchor.seq === checkpoint.floor.seq && anchor.hash !== checkpoint.floor.hash))
    )
      throw new JournalError('integrity')
    let currentHash = head.hash
    const reverse: AcceptedDeletion[] = []
    for (let seq = head.seq; seq > anchor.seq; seq--) {
      const result = await this.options.store.read(this.recordKey(currentHash))
      if (!result || sha(result.bytes) !== currentHash) throw new JournalError('integrity')
      const parsed = journalRecordSchema.safeParse(this.decrypt('record', result.bytes))
      if (!parsed.success || parsed.data.seq !== seq) throw new JournalError('integrity')
      reverse.push({ record: parsed.data, hash: currentHash })
      currentHash = parsed.data.previousHash
    }
    if (currentHash !== anchor.hash) throw new JournalError('integrity')
    return reverse.reverse()
  }
  async append(input: Parameters<DeletionJournal['append']>[0]): Promise<AcceptedDeletion> {
    const intent = deletionIntentSchema.parse(input.intent)
    const fingerprint = deletionFingerprint({
      operationId: input.operationId,
      actorId: input.actorId,
      intent,
    })
    for (let attempt = 0; attempt <= 8; attempt++) {
      const { head, etag } = await this.head()
      // Reconcile only the trusted chain: an orphan candidate or an untrusted operation index is never acceptance.
      const checkpoint = await this.readCheckpoint(head)
      const floor = checkpoint?.floor ?? { seq: 0, hash: JOURNAL_GENESIS }
      const records = await this.readSinceHead(floor, head)
      const accepted = records.find((item) => item.record.operationId === input.operationId)
      if (accepted) {
        const record = accepted.record
        if (
          deletionFingerprint({
            operationId: record.operationId,
            actorId: record.actorId,
            intent: record.intent,
          }) !== fingerprint
        )
          throw new JournalError('conflict')
        return accepted
      }
      if (head.writerEpoch !== this.options.writerEpoch) throw new JournalError('stale_writer')
      // A retry older than the authenticated floor cannot become a new deletion after its old record was removed.
      if (
        checkpoint &&
        Date.parse(input.preparedAt ?? input.acceptedAt) <= Date.parse(checkpoint.pruneBefore)
      )
        throw new JournalError('conflict')
      if (attempt === 8) break // Reconcile the eighth CAS before declaring contention.
      const record = journalRecordSchema.parse({
        format: 1,
        ruleVersion: 1,
        writerEpoch: head.writerEpoch,
        seq: head.seq + 1,
        previousHash: head.hash,
        ...input,
        intent,
      })
      const encoded = this.encrypt('record', record)
      const hash = sha(encoded)
      const recordKey = this.recordKey(hash)
      try {
        await this.options.store.write(recordKey, encoded, { absent: true })
      } catch {
        // A lost response may still have committed. Read-back below establishes the exact immutable candidate.
      }
      const verified = await this.options.store.read(recordKey)
      if (!verified || sha(verified.bytes) !== hash) throw new JournalError('integrity')
      const next: JournalHead = { ...head, seq: record.seq, hash, recordKey }
      try {
        await this.options.store.write(this.headKey, this.encrypt('head', next), { etag })
      } catch {
        // Keep this operation id and inspect the head on the next pass; do not invent a replacement operation.
      }
    }
    throw new JournalError('contended')
  }

  /** The maintenance controller must hold both writer and backup-catalog locks and verify ALL remote snapshots. */
  async checkpoint(
    applied: JournalAnchor,
    inventory: readonly { snapshotId: string; manifest: BackupManifest }[],
  ): Promise<{ floor: JournalAnchor; deleted: number }> {
    const now = (this.options.now ?? (() => new Date()))()
    const cutoff = new Date(now.getTime() - 35 * 86_400_000)
    const { head, etag } = await this.head()
    if (head.writerEpoch !== this.options.writerEpoch) throw new JournalError('stale_writer')
    const prior = await this.readCheckpoint(head)
    if (!Number.isFinite(now.getTime()) || (prior && now < new Date(prior.createdAt)))
      throw new JournalError('integrity')
    const floor = prior?.floor ?? { seq: 0, hash: JOURNAL_GENESIS }
    if (
      !inventory.length ||
      new Set(inventory.map((item) => item.snapshotId)).size !== inventory.length ||
      inventory.some((item) => !/^[a-f0-9]{64}$/.test(item.snapshotId))
    )
      throw new JournalError('integrity')
    const records = await this.readSinceHead(floor, head)
    for (const item of inventory) backupManifestSchema.parse(item.manifest)
    const anchors = new Map<number, string>([
      [floor.seq, floor.hash],
      ...records.map((item) => [item.record.seq, item.hash] as [number, string]),
    ])
    if (
      anchors.get(applied.seq) !== applied.hash ||
      inventory.some(
        (item) => anchors.get(item.manifest.journal.seq) !== item.manifest.journal.hash,
      )
    )
      throw new JournalError('integrity')
    const bound = Math.min(applied.seq, ...inventory.map((item) => item.manifest.journal.seq))
    let nextFloor = floor
    for (const item of records) {
      if (item.record.seq > bound || Date.parse(item.record.acceptedAt) > cutoff.getTime()) break
      nextFloor = { seq: item.record.seq, hash: item.hash }
    }
    let checkpoint = prior
    if (nextFloor.seq > floor.seq) {
      checkpoint = journalCheckpointSchema.parse({
        format: 1,
        floor: nextFloor,
        createdAt: now.toISOString(),
        pruneBefore: cutoff.toISOString(),
        catalogHash: deletionFingerprint(
          [...inventory]
            .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId))
            .map((item) => ({
              snapshotId: item.snapshotId,
              manifestHash: deletionFingerprint(item.manifest),
            })),
        ),
        snapshotCount: inventory.length,
      })
      const encoded = this.encrypt('checkpoint', checkpoint),
        hash = sha(encoded),
        key = this.checkpointKey(hash)
      try {
        await this.options.store.write(key, encoded, { absent: true })
      } catch {
        /* Read-back resolves an unknown write. */
      }
      const verified = await this.options.store.read(key)
      if (!verified || sha(verified.bytes) !== hash) throw new JournalError('integrity')
      try {
        await this.options.store.write(
          this.headKey,
          this.encrypt('head', { ...head, checkpoint: { key, hash } }),
          { etag },
        )
      } catch {
        /* Read-back resolves an unknown CAS. */
      }
      const accepted = (await this.head()).head
      if (accepted.checkpoint?.hash !== hash) throw new JournalError('contended')
    }
    if (!checkpoint) return { floor, deleted: 0 }
    // Also resumes an interrupted GC. No key outside the immutable record namespace can be removed.
    let deleted = 0,
      cursor: string | undefined
    const cursors = new Set<string>()
    do {
      const page = await this.options.store.list(`${this.options.prefix}records/`, cursor)
      for (const key of page.keys) {
        const hash = key.slice(`${this.options.prefix}records/`.length)
        if (!/^[a-f0-9]{64}$/.test(hash) || key !== this.recordKey(hash))
          throw new JournalError('integrity')
        const object = await this.options.store.read(key)
        if (!object) continue
        if (sha(object.bytes) !== hash) throw new JournalError('integrity')
        const parsed = journalRecordSchema.safeParse(this.decrypt('record', object.bytes))
        if (!parsed.success) throw new JournalError('integrity')
        if (
          parsed.data.seq <= checkpoint.floor.seq &&
          Date.parse(parsed.data.acceptedAt) <= Date.parse(checkpoint.pruneBefore)
        ) {
          await this.options.store.delete(key)
          deleted++
        }
      }
      cursor = page.cursor
      if (cursor && cursors.has(cursor)) throw new JournalError('integrity')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return { floor: checkpoint.floor, deleted }
  }
  /** Requires the operator to stop the old writer and revoke its credentials separately. CAS alone is logical fencing. */
  async rotateWriter(expectedEpoch: string, nextEpoch: string): Promise<void> {
    if (!journalHeadSchema.shape.writerEpoch.safeParse(nextEpoch).success)
      throw new JournalError('integrity')
    const { head, etag } = await this.head()
    if (head.writerEpoch !== expectedEpoch) throw new JournalError('stale_writer')
    const rotated = { ...head, writerEpoch: nextEpoch }
    if (!(await this.options.store.write(this.headKey, this.encrypt('head', rotated), { etag })))
      throw new JournalError('contended')
    if ((await this.head()).head.writerEpoch !== nextEpoch) throw new JournalError('stale_writer')
  }
}
