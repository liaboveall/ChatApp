import { createHash, randomBytes } from 'node:crypto'
import { AppError, UPLOAD_LIMITS } from '@chatapp/contracts'
import type { MediaSuccess } from '@chatapp/contracts/media'
import {
  attachmentObjects,
  attachments,
  siteStorage,
  uploadReservations,
  users,
  workItems,
} from '@chatapp/db'
import { and, eq, gt, inArray, isNull, lt, lte, notExists, or, sql } from 'drizzle-orm'
import { MediaClientError } from '../runtime/media.ts'
import { blobStore, classifyFile, lockStorage } from './attachment-common.ts'
import { enforce, loadAccess } from './authorize.ts'
import { enqueueHint, recordUserChange } from './changes.ts'
import type { Deps } from './deps.ts'
import { lockUsers } from './sessions.ts'
import { inTransaction } from './tx.ts'
import { retireAttachment } from './uploads.ts'
import { beginWork, failWork, type WorkLease } from './work-queue.ts'

async function prefix(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const bytes = new Uint8Array(64)
  let offset = 0
  try {
    while (offset < 64) {
      const chunk = await reader.read()
      if (chunk.done) break
      const length = Math.min(chunk.value.length, 64 - offset)
      bytes.set(chunk.value.subarray(0, length), offset)
      offset += length
    }
    return bytes.subarray(0, offset)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
async function currentUploader(
  tx: import('@chatapp/db').Tx,
  deps: Deps,
  a: typeof attachments.$inferSelect,
) {
  const [user] = await lockUsers(tx, [a.uploaderId])
  if (!user || user.deletedAt || user.banned || user.activationStatus !== 'active')
    throw new AppError('FORBIDDEN', 'Uploader unavailable')
  if (a.conversationId) {
    const access = await loadAccess(tx, a.uploaderId, a.conversationId, { lock: true })
    enforce(
      access,
      { userId: user.id, siteRole: user.role },
      a.purpose === 'conversation_avatar' ? 'update' : 'send_message',
      deps.clock.now(),
    )
  }
}
/** Processing uses unique generations. Neither a stale work lease nor a cancelled upload can publish outputs. */
export async function processAttachment(
  deps: Deps,
  lease: WorkLease,
): Promise<'ready' | 'stale' | 'retry' | 'failed'> {
  const work = await beginWork(deps, lease)
  if (work?.kind !== 'media' || !work.entityId) return 'stale'
  const store = blobStore(deps)
  let generation: number | undefined
  try {
    const [head] = await deps.db.select().from(attachments).where(eq(attachments.id, work.entityId))
    if (!head) return 'stale'
    const claim = await inTransaction(deps.db, async (tx) => {
      await currentUploader(tx, deps, head)
      const site = await lockStorage(tx)
      const [a] = await tx
        .select()
        .from(attachments)
        .where(eq(attachments.id, head.id))
        .for('update')
      const [r] = await tx
        .select()
        .from(uploadReservations)
        .where(eq(uploadReservations.attachmentId, head.id))
        .for('update')
      const [w] = await tx
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.id, lease.id),
            eq(workItems.leaseEpoch, lease.leaseEpoch),
            eq(workItems.status, 'running'),
          ),
        )
        .for('update')
      if (
        !a ||
        !r ||
        !w ||
        a.status !== 'processing' ||
        !['uploaded', 'processing'].includes(r.status)
      )
        return null
      const [input] = await tx
        .select()
        .from(attachmentObjects)
        .where(
          and(
            eq(attachmentObjects.attachmentId, a.id),
            eq(attachmentObjects.variant, 'input'),
            eq(attachmentObjects.status, 'staging'),
          ),
        )
      if (!input?.sha256 || input.sizeBytes !== a.rawSizeBytes)
        throw new AppError('CONFLICT', 'Upload input missing')
      const prior = await tx
        .select()
        .from(attachmentObjects)
        .where(
          and(
            eq(attachmentObjects.attachmentId, a.id),
            sql`${attachmentObjects.variant} <> 'input' and ${attachmentObjects.status} <> 'deleted'`,
          ),
        )
      const extra = prior.length ? r.reservedBytes + UPLOAD_LIMITS.variantBytes : 0
      if (site.uploadsBlocked || site.usedBytes + site.reservedBytes + extra > site.budgetBytes)
        throw new AppError('CAPACITY_UNAVAILABLE', 'Processing capacity unavailable')
      if (extra) {
        await tx
          .update(siteStorage)
          .set({ reservedBytes: sql`${siteStorage.reservedBytes} + ${extra}` })
          .where(eq(siteStorage.id, 1))
        await tx
          .update(uploadReservations)
          .set({ siteReservedBytes: sql`${uploadReservations.siteReservedBytes} + ${extra}` })
          .where(eq(uploadReservations.id, r.id))
        r.siteReservedBytes += extra
      }
      const next = a.generation + 1
      await tx
        .update(attachmentObjects)
        .set({
          status: 'deleting',
          deleteAfter: new Date(deps.clock.now().getTime() + UPLOAD_LIMITS.leaseMs),
        })
        .where(
          and(
            eq(attachmentObjects.attachmentId, a.id),
            sql`${attachmentObjects.variant} <> 'input'`,
            eq(attachmentObjects.status, 'staging'),
          ),
        )
      await tx
        .update(attachments)
        .set({ generation: next, version: sql`${attachments.version} + 1` })
        .where(eq(attachments.id, a.id))
      await tx
        .update(uploadReservations)
        .set({
          status: 'processing',
          leaseEpoch: lease.leaseEpoch,
          expiresAt: new Date(deps.clock.now().getTime() + UPLOAD_LIMITS.leaseMs),
        })
        .where(eq(uploadReservations.id, r.id))
      return { a, r, input, generation: next }
    })
    if (!claim) {
      await deps.db
        .update(workItems)
        .set({ status: 'done', leaseUntil: null, finishedAt: deps.clock.now() })
        .where(and(eq(workItems.id, lease.id), eq(workItems.leaseEpoch, lease.leaseEpoch)))
      return 'stale'
    }
    generation = claim.generation
    const type = classifyFile(await prefix(store.read(claim.input.storageKey, 0, 64)))
    if (
      (type.kind === 'image' || claim.a.purpose !== 'message') &&
      claim.input.sizeBytes > UPLOAD_LIMITS.imageBytes
    )
      throw new AppError('PAYLOAD_TOO_LARGE', 'Image exceeds limit')
    if (claim.a.purpose !== 'message' && type.kind !== 'image')
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Avatar must be an image')
    const outputs: {
      variant: string
      key: string
      size: number
      hash: string
      mime: string
      width: number | null
      height: number | null
    }[] = []
    const save = async (
      file: {
        variant: string
        bytes: number
        sha256: string
        mime: string
        width: number | null
        height: number | null
      },
      stream: ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ) => {
      const key = `att/${claim.a.id}/${claim.generation}/${file.variant}`
      // Intent survives a worker dying between its external PUT and publication.
      await inTransaction(deps.db, async (tx) => {
        await lockStorage(tx)
        const [a] = await tx
          .select()
          .from(attachments)
          .where(eq(attachments.id, claim.a.id))
          .for('update')
        const [w] = await tx
          .select()
          .from(workItems)
          .where(
            and(
              eq(workItems.id, lease.id),
              eq(workItems.leaseEpoch, lease.leaseEpoch),
              eq(workItems.status, 'running'),
              sql`${workItems.leaseUntil} > ${deps.clock.now()}`,
            ),
          )
        if (!a || a.generation !== claim.generation || a.status !== 'processing' || !w)
          throw new AppError('CONFLICT', 'Stale output producer')
        await tx.insert(attachmentObjects).values({
          attachmentId: claim.a.id,
          generation: claim.generation,
          variant: file.variant,
          storageKey: key,
          sizeBytes: file.bytes,
          sha256: file.sha256,
          deleteAfter: new Date(deps.clock.now().getTime() + UPLOAD_LIMITS.leaseMs * 2),
        })
      })
      const digest = createHash('sha256')
      let received = 0
      const verified = stream.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, output) {
            received += chunk.byteLength
            if (received > file.bytes) throw new AppError('CONFLICT', 'Stored output size mismatch')
            digest.update(chunk)
            output.enqueue(chunk)
          },
          flush() {
            if (received !== file.bytes || digest.digest('hex') !== file.sha256)
              throw new AppError('CONFLICT', 'Stored output digest mismatch')
          },
        }),
        { signal },
      )
      const size = await store.put(key, verified, signal)
      const stat = await store.stat(key)
      if (size !== file.bytes || stat?.size !== file.bytes)
        throw new AppError('CONFLICT', 'Stored output size mismatch')
      outputs.push({
        variant: file.variant,
        key,
        size,
        hash: file.sha256,
        mime: file.mime,
        width: file.width,
        height: file.height,
      })
    }
    let result: Omit<
      Pick<MediaSuccess, 'kind' | 'width' | 'height' | 'durationMs' | 'thumbhash'>,
      'kind'
    > & { kind: typeof claim.a.kind; metadataCleared: boolean | null }
    if (type.kind === 'image' || type.kind === 'video') {
      if (!deps.media) throw new MediaClientError('connect_failed')
      const media = await deps.media.process(
        {
          v: 1,
          jobId: work.id,
          generation: claim.generation,
          nonce: randomBytes(32).toString('hex'),
          operation: claim.a.purpose === 'message' ? type.kind : 'avatar',
          inputBytes: claim.input.sizeBytes,
          inputSha256: claim.input.sha256 ?? '',
          maxOutputBytes: type.kind === 'image' ? UPLOAD_LIMITS.imageBytes : claim.r.reservedBytes,
        },
        store.read(claim.input.storageKey),
        save,
      )
      result = media
    } else {
      await save(
        {
          variant: 'original',
          bytes: claim.input.sizeBytes,
          sha256: claim.input.sha256 ?? '',
          mime: type.mime,
          width: null,
          height: null,
        },
        store.read(claim.input.storageKey),
        AbortSignal.timeout(60_000),
      )
      result = {
        kind: type.kind,
        width: null,
        height: null,
        durationMs: null,
        thumbhash: null,
        metadataCleared: null,
      }
    }
    const original = outputs.find((file) => file.variant === 'original')
    if (!original) throw new AppError('CONFLICT', 'Processed original missing')
    const total = outputs.reduce((sum, file) => sum + file.size, claim.input.sizeBytes)
    if (original.size > claim.r.reservedBytes || total > claim.r.siteReservedBytes)
      throw new AppError('CAPACITY_UNAVAILABLE', 'Output exceeded reservation')
    const published = await inTransaction(deps.db, async (tx) => {
      await currentUploader(tx, deps, claim.a)
      await lockStorage(tx)
      const [a] = await tx
        .select()
        .from(attachments)
        .where(eq(attachments.id, claim.a.id))
        .for('update')
      const [r] = await tx
        .select()
        .from(uploadReservations)
        .where(eq(uploadReservations.id, claim.r.id))
        .for('update')
      const [w] = await tx
        .select()
        .from(workItems)
        .where(
          and(
            eq(workItems.id, lease.id),
            eq(workItems.leaseEpoch, lease.leaseEpoch),
            eq(workItems.status, 'running'),
            sql`${workItems.leaseUntil} > ${deps.clock.now()}`,
          ),
        )
        .for('update')
      if (
        !a ||
        !r ||
        !w ||
        a.generation !== claim.generation ||
        a.status !== 'processing' ||
        r.status !== 'processing' ||
        r.leaseEpoch !== lease.leaseEpoch ||
        r.expiresAt <= deps.clock.now()
      )
        return false
      const held = await tx
        .select()
        .from(attachmentObjects)
        .where(
          and(
            eq(attachmentObjects.attachmentId, a.id),
            sql`${attachmentObjects.status} <> 'deleted'`,
          ),
        )
      const accountedTotal = held.reduce(
        (sum, item) => sum + (item.accounted ? 0 : item.sizeBytes),
        0,
      )
      if (accountedTotal > r.siteReservedBytes)
        throw new AppError('CAPACITY_UNAVAILABLE', 'Held output capacity exceeded')
      await tx
        .update(attachmentObjects)
        .set({ accounted: true })
        .where(
          and(
            eq(attachmentObjects.attachmentId, a.id),
            sql`${attachmentObjects.status} <> 'deleted'`,
          ),
        )
      const variants: typeof a.variants = {}
      for (const file of outputs)
        if (file.variant !== 'original')
          variants[file.variant] = { key: file.key, w: file.width, h: file.height, mime: file.mime }
      await tx
        .update(attachments)
        .set({
          status: 'ready',
          kind: result.kind,
          mime: original.mime,
          storageKey: original.key,
          sizeBytes: original.size,
          chargedBytes: original.size,
          sha256: original.hash,
          width: result.width,
          height: result.height,
          durationMs: result.durationMs,
          metadataCleared: result.metadataCleared,
          thumbhash: result.thumbhash,
          variants,
          version: sql`${attachments.version} + 1`,
        })
        .where(eq(attachments.id, a.id))
      await tx
        .update(users)
        .set({
          storageReservedBytes: sql`${users.storageReservedBytes} - ${r.reservedBytes}`,
          storageUsedBytes: sql`${users.storageUsedBytes} + ${original.size}`,
          meVersion: sql`${users.meVersion} + 1`,
        })
        .where(eq(users.id, a.uploaderId))
      await tx
        .update(siteStorage)
        .set({
          reservedBytes: sql`${siteStorage.reservedBytes} - ${r.siteReservedBytes}`,
          usedBytes: sql`${siteStorage.usedBytes} + ${accountedTotal}`,
        })
        .where(eq(siteStorage.id, 1))
      await tx
        .update(uploadReservations)
        .set({ status: 'settled', siteReservedBytes: 0 })
        .where(eq(uploadReservations.id, r.id))
      await tx
        .update(attachmentObjects)
        .set({ status: 'live', accounted: true, deleteAfter: null })
        .where(
          and(
            eq(attachmentObjects.attachmentId, a.id),
            eq(attachmentObjects.generation, claim.generation),
          ),
        )
      await tx
        .update(attachmentObjects)
        .set({ status: 'deleting', accounted: true, deleteAfter: deps.clock.now() })
        .where(eq(attachmentObjects.id, claim.input.id))
      await tx
        .update(workItems)
        .set({ status: 'done', leaseUntil: null, finishedAt: deps.clock.now() })
        .where(eq(workItems.id, w.id))
      await enqueueHint(tx, deps, {
        event: 'attachment.updated',
        userId: a.uploaderId,
        attachmentId: a.id,
        generation: a.generation,
        version: a.version + 1,
      })
      await recordUserChange(tx, deps, {
        userId: a.uploaderId,
        entityType: 'me',
        entityId: a.uploaderId,
      })
      return true
    })
    return published ? 'ready' : 'stale'
  } catch (error) {
    const transient =
      (error instanceof AppError && error.code === 'CAPACITY_UNAVAILABLE') ||
      (error instanceof MediaClientError &&
        ['busy', 'connect_failed', 'transport_failed', 'timeout', 'aborted'].includes(error.code))
    const outcome = await failWork(deps, lease, {
      kind: 'media',
      errorCode:
        error instanceof MediaClientError
          ? error.code
          : error instanceof AppError
            ? error.code
            : 'processing_failed',
    })
    if (!transient || outcome === 'dead')
      await failAttachment(deps, work.entityId, lease, generation)
    return transient && outcome !== 'dead' ? 'retry' : 'failed'
  }
}
async function failAttachment(
  deps: Deps,
  id: string,
  lease: WorkLease,
  generation?: number,
): Promise<void> {
  const [head] = await deps.db.select().from(attachments).where(eq(attachments.id, id))
  if (!head) return
  await inTransaction(deps.db, async (tx) => {
    await lockUsers(tx, [head.uploaderId])
    await lockStorage(tx)
    const [a] = await tx.select().from(attachments).where(eq(attachments.id, id)).for('update')
    const [work] = await tx.select().from(workItems).where(eq(workItems.id, lease.id)).for('update')
    if (
      work?.leaseEpoch !== lease.leaseEpoch ||
      a?.status !== 'processing' ||
      (generation !== undefined && a.generation !== generation)
    )
      return
    await retireAttachment(tx, deps, id)
    await tx
      .update(attachments)
      .set({ status: 'failed', version: sql`${attachments.version}+1` })
      .where(eq(attachments.id, id))
    await enqueueHint(tx, deps, {
      event: 'attachment.updated',
      userId: a.uploaderId,
      attachmentId: a.id,
      generation: a.generation + 1,
      version: a.version + 2,
    })
  })
}
/** Independent Postgres cleanup survives loss of BullMQ, worker restarts and incomplete PUTs. */
export async function cleanupAttachments(
  deps: Deps,
): Promise<{ retired: number; deleted: number }> {
  const now = deps.clock.now(),
    store = blobStore(deps)
  const expired = await deps.db
    .select({ a: attachments, r: uploadReservations })
    .from(attachments)
    .innerJoin(uploadReservations, eq(uploadReservations.attachmentId, attachments.id))
    .where(
      and(
        inArray(attachments.status, ['uploading', 'processing', 'ready']),
        or(
          and(eq(uploadReservations.status, 'reserved'), lt(uploadReservations.expiresAt, now)),
          and(
            eq(attachments.status, 'processing'),
            notExists(
              deps.db
                .select({ one: sql`1` })
                .from(workItems)
                .where(
                  and(
                    eq(workItems.entityId, attachments.id),
                    eq(workItems.kind, 'media'),
                    sql`${workItems.status} not in ('dead','done')`,
                  ),
                ),
            ),
          ),
          and(
            eq(attachments.status, 'ready'),
            isNull(attachments.messageId),
            lt(attachments.createdAt, new Date(now.getTime() - UPLOAD_LIMITS.orphanMs)),
            sql`not exists (select 1 from users where avatar_attachment_id = ${attachments.id}) and not exists (select 1 from conversations where avatar_attachment_id = ${attachments.id})`,
          ),
        ),
      ),
    )
    .limit(100)
  let retired = 0,
    deleted = 0
  for (const { a: head } of expired) {
    await inTransaction(deps.db, async (tx) => {
      await lockUsers(tx, [head.uploaderId])
      await lockStorage(tx)
      const [a] = await tx
        .select()
        .from(attachments)
        .where(eq(attachments.id, head.id))
        .for('update')
      if (!a || a.messageId || !['uploading', 'processing', 'ready'].includes(a.status)) return
      const [r] = await tx
        .select()
        .from(uploadReservations)
        .where(eq(uploadReservations.attachmentId, a.id))
        .for('update')
      if (!r) return
      if (a.status === 'uploading' && (r.status !== 'reserved' || r.expiresAt >= now)) return
      if (a.status === 'processing') {
        const [active] = await tx
          .select({ id: workItems.id })
          .from(workItems)
          .where(
            and(
              eq(workItems.entityId, a.id),
              eq(workItems.kind, 'media'),
              sql`${workItems.status} not in ('dead','done')`,
            ),
          )
        if (active) return
      }
      if (a.status === 'ready' && a.createdAt >= new Date(now.getTime() - UPLOAD_LIMITS.orphanMs))
        return
      const pointers = await tx.execute(
        sql`select 1 from users where avatar_attachment_id = ${a.id} union all select 1 from conversations where avatar_attachment_id = ${a.id}`,
      )
      if (pointers.length) return
      await retireAttachment(tx, deps, a.id)
      retired++
    })
  }
  const pending = await deps.db
    .select()
    .from(attachmentObjects)
    .where(and(eq(attachmentObjects.status, 'deleting'), lte(attachmentObjects.deleteAfter, now)))
    .limit(200)
  for (const object of pending) {
    await store.delete(object.storageKey)
    if (await store.stat(object.storageKey)) continue
    await inTransaction(deps.db, async (tx) => {
      await lockStorage(tx)
      const [o] = await tx
        .select()
        .from(attachmentObjects)
        .where(eq(attachmentObjects.id, object.id))
        .for('update')
      if (o?.status !== 'deleting') return
      if (o.accounted)
        await tx
          .update(siteStorage)
          .set({ usedBytes: sql`${siteStorage.usedBytes} - ${o.sizeBytes}` })
          .where(eq(siteStorage.id, 1))
      await tx
        .update(attachmentObjects)
        .set({ status: 'deleted', accounted: false, deletedAt: now })
        .where(eq(attachmentObjects.id, o.id))
      deleted++
    })
  }
  // Release uncertain capacity ONLY once every intended key is confirmed deleted.
  await inTransaction(deps.db, async (tx) => {
    await lockStorage(tx)
    const reservations = await tx
      .select()
      .from(uploadReservations)
      .where(
        and(
          eq(uploadReservations.status, 'released'),
          sql`${uploadReservations.siteReservedBytes} > 0`,
          notExists(
            tx
              .select({ one: sql`1` })
              .from(attachmentObjects)
              .where(
                and(
                  eq(attachmentObjects.attachmentId, uploadReservations.attachmentId),
                  sql`${attachmentObjects.status} <> 'deleted'`,
                ),
              ),
          ),
        ),
      )
      .for('update')
    for (const r of reservations) {
      await tx
        .update(siteStorage)
        .set({ reservedBytes: sql`${siteStorage.reservedBytes} - ${r.siteReservedBytes}` })
        .where(eq(siteStorage.id, 1))
      await tx
        .update(uploadReservations)
        .set({ siteReservedBytes: 0 })
        .where(eq(uploadReservations.id, r.id))
    }
  })
  return { retired, deleted }
}

/** Reconciliation changes only counters provable from committed intent/live/tombstone rows. Unknown objects stop admission. */
export async function reconcileStorage(deps: Deps): Promise<{ blocked: boolean; checked: number }> {
  try {
    return await reconcileStorageObjects(deps)
  } catch (error) {
    await inTransaction(deps.db, async (tx) => {
      await lockStorage(tx)
      await tx.update(siteStorage).set({ uploadsBlocked: true }).where(eq(siteStorage.id, 1))
    })
    throw error
  }
}
async function reconcileStorageObjects(deps: Deps): Promise<{ blocked: boolean; checked: number }> {
  const store = blobStore(deps)
  let checked = 0,
    unexplained = false
  let cursor: string | undefined
  do {
    const page = await store.list(cursor)
    const ledgerRows = page.items.length
      ? await deps.db
          .select()
          .from(attachmentObjects)
          .where(
            inArray(
              attachmentObjects.storageKey,
              page.items.map((item) => item.key),
            ),
          )
      : []
    const byKey = new Map(ledgerRows.map((row) => [row.storageKey, row]))
    for (const item of page.items) {
      const ledger = byKey.get(item.key)
      checked++
      if (
        !ledger ||
        ledger.status === 'deleted' ||
        (ledger.status === 'live' && ledger.sizeBytes !== item.size)
      ) {
        // LIST can race a confirmed delete. Only a difference still present at HEAD blocks admission.
        const actual = await store.stat(item.key)
        if (actual && (!ledger || ledger.status === 'deleted' || actual.size !== ledger.sizeBytes))
          unexplained = true
      }
    }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  let objectAfter: string | undefined
  while (true) {
    const live = await deps.db
      .select()
      .from(attachmentObjects)
      .where(
        and(
          eq(attachmentObjects.status, 'live'),
          objectAfter ? gt(attachmentObjects.id, objectAfter) : undefined,
        ),
      )
      .orderBy(attachmentObjects.id)
      .limit(100)
    if (!live.length) break
    for (const object of live) {
      const actual = await store.stat(object.storageKey)
      if (!actual || actual.size !== object.sizeBytes) {
        // A live row may have been retired after it was selected; compare again before blocking admission.
        const [current] = await deps.db
          .select()
          .from(attachmentObjects)
          .where(eq(attachmentObjects.id, object.id))
        if (current?.status === 'live') unexplained = true
      }
    }
    objectAfter = live.at(-1)?.id
  }
  await inTransaction(deps.db, async (tx) => {
    await lockStorage(tx)
    const [used] = await tx
      .select({ n: sql<number>`coalesce(sum(${attachmentObjects.sizeBytes}), 0)::bigint` })
      .from(attachmentObjects)
      .where(eq(attachmentObjects.accounted, true))
    const [reserved] = await tx
      .select({ n: sql<number>`coalesce(sum(${uploadReservations.siteReservedBytes}), 0)::bigint` })
      .from(uploadReservations)
    await tx
      .update(siteStorage)
      .set({
        usedBytes: Number(used?.n ?? 0),
        reservedBytes: Number(reserved?.n ?? 0),
        uploadsBlocked: unexplained,
      })
      .where(eq(siteStorage.id, 1))
  })
  // Repair differences in bounded pages under the user lock; no site-wide lock is needed here.
  let after: string | undefined
  while (true) {
    const people: { id: string }[] = await deps.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          after ? gt(users.id, after) : undefined,
          sql`(${users.storageUsedBytes} <> (select coalesce(sum(a.charged_bytes),0) from attachments a where a.uploader_id = ${users.id}) or ${users.storageReservedBytes} <> (select coalesce(sum(r.reserved_bytes),0) from upload_reservations r where r.user_id = ${users.id} and r.status in ('reserved','uploaded','processing')))`,
        ),
      )
      .orderBy(users.id)
      .limit(100)
    if (!people.length) break
    for (const person of people)
      await inTransaction(deps.db, async (tx) => {
        const [user] = await lockUsers(tx, [person.id])
        if (!user) return
        const [used] = await tx
          .select({ n: sql<number>`coalesce(sum(${attachments.chargedBytes}),0)::bigint` })
          .from(attachments)
          .where(eq(attachments.uploaderId, person.id))
        const [reserved] = await tx
          .select({ n: sql<number>`coalesce(sum(${uploadReservations.reservedBytes}),0)::bigint` })
          .from(uploadReservations)
          .where(
            and(
              eq(uploadReservations.userId, person.id),
              inArray(uploadReservations.status, ['reserved', 'uploaded', 'processing']),
            ),
          )
        const storageUsedBytes = Number(used?.n ?? 0),
          storageReservedBytes = Number(reserved?.n ?? 0)
        if (
          user.storageUsedBytes === storageUsedBytes &&
          user.storageReservedBytes === storageReservedBytes
        )
          return
        await tx
          .update(users)
          .set({ storageUsedBytes, storageReservedBytes, meVersion: sql`${users.meVersion}+1` })
          .where(eq(users.id, person.id))
        await recordUserChange(tx, deps, {
          userId: person.id,
          entityType: 'me',
          entityId: person.id,
        })
      })
    after = people.at(-1)?.id
  }
  if (unexplained)
    deps.log.error('storage.reconciliation_blocked', {
      count: checked,
      reason: 'unexplained_object_difference',
    })
  return { blocked: unexplained, checked }
}
