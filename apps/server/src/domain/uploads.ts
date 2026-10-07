/** Atomic quota reservations; external writes have durable intent rows BEFORE storage receives bytes. */
import { createHash } from 'node:crypto'
import {
  AppError,
  LIMITS,
  type ReserveUpload,
  UPLOAD_LIMITS,
  type Upload,
} from '@chatapp/contracts'
import { attachmentObjects, attachments, siteStorage, uploadReservations, users } from '@chatapp/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { fingerprint } from '../lib/crypto.ts'
import {
  attachmentDto,
  attachmentMissing,
  blobStore,
  lockStorage,
  safeFilename,
} from './attachment-common.ts'
import { enforce, loadAccess } from './authorize.ts'
import { enqueueHint, recordUserChange } from './changes.ts'
import type { Deps } from './deps.ts'
import { assertIdempotencyKey } from './idempotency.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'
import { enqueueWork } from './work.ts'

export async function reserveUpload(
  deps: Deps,
  principal: SessionPrincipal,
  input: ReserveUpload,
  key: string,
): Promise<Upload> {
  assertIdempotencyKey(key)
  let capacity: { dataFreeBytes: number; metadataFreeBytes: number } | undefined
  try {
    capacity = await blobStore(deps).capacity()
  } catch {
    capacity = undefined
  }
  const hash = fingerprint(input)
  const maxBytes =
    input.declaredSize ??
    (input.purpose === 'message' ? UPLOAD_LIMITS.fileBytes : UPLOAD_LIMITS.imageBytes)
  if (input.purpose !== 'message' && maxBytes > UPLOAD_LIMITS.imageBytes)
    throw new AppError('PAYLOAD_TOO_LARGE', 'Avatar exceeds image limit')
  const reservedBytes = Math.max(maxBytes, UPLOAD_LIMITS.imageBytes)
  const peakBytes = reservedBytes * 2 + UPLOAD_LIMITS.variantBytes
  const id = await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal)
    if (input.conversationId) {
      const access = await loadAccess(tx, principal.userId, input.conversationId, { lock: true })
      enforce(
        access,
        { userId: principal.userId, siteRole: user.role },
        input.purpose === 'conversation_avatar' ? 'update' : 'send_message',
        deps.clock.now(),
      )
    }
    const [existing] = await tx
      .select()
      .from(uploadReservations)
      .where(
        and(eq(uploadReservations.userId, user.id), eq(uploadReservations.idempotencyKey, key)),
      )
    if (existing) {
      if (existing.requestHash !== hash)
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'The upload key was used with a different request',
        )
      return existing.id
    }
    if (!capacity) throw new AppError('CAPACITY_UNAVAILABLE', 'Storage capacity probe unavailable')
    const site = await lockStorage(tx)
    if (
      user.storageUsedBytes + user.storageReservedBytes + reservedBytes >
      (user.storageQuotaBytes ?? LIMITS.defaultStorageQuotaBytes)
    )
      throw new AppError('QUOTA_EXCEEDED', 'Storage quota exceeded')
    if (
      capacity.dataFreeBytes < site.reservedBytes + peakBytes + 256 * 1024 * 1024 ||
      capacity.metadataFreeBytes < 256 * 1024 * 1024
    )
      throw new AppError('CAPACITY_UNAVAILABLE', 'Physical storage capacity unavailable')
    if (site.uploadsBlocked || site.usedBytes + site.reservedBytes + peakBytes > site.budgetBytes)
      throw new AppError('CAPACITY_UNAVAILABLE', 'Storage capacity unavailable')
    const attachmentId = deps.newId(),
      uploadId = deps.newId()
    await tx.insert(attachments).values({
      id: attachmentId,
      uploaderId: user.id,
      purpose: input.purpose,
      conversationId: input.conversationId,
      originalName: safeFilename(input.name),
      createdAt: deps.clock.now(),
    })
    await tx.insert(uploadReservations).values({
      id: uploadId,
      attachmentId,
      userId: user.id,
      idempotencyKey: key,
      requestHash: hash,
      reservedBytes,
      siteReservedBytes: peakBytes,
      maxBytes,
      expiresAt: new Date(deps.clock.now().getTime() + UPLOAD_LIMITS.reservationMs),
      createdAt: deps.clock.now(),
    })
    await tx
      .update(users)
      .set({ storageReservedBytes: sql`${users.storageReservedBytes} + ${reservedBytes}` })
      .where(eq(users.id, user.id))
    await tx
      .update(siteStorage)
      .set({ reservedBytes: sql`${siteStorage.reservedBytes} + ${peakBytes}` })
      .where(eq(siteStorage.id, 1))
    return uploadId
  })
  return getUpload(deps, principal, id)
}
export async function getUpload(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<Upload> {
  const [found] = await deps.db
    .select({ reservation: uploadReservations, attachment: attachments })
    .from(uploadReservations)
    .innerJoin(attachments, eq(attachments.id, uploadReservations.attachmentId))
    .where(and(eq(uploadReservations.id, id), eq(uploadReservations.userId, principal.userId)))
  if (!found) throw attachmentMissing()
  return {
    uploadId: id,
    attachmentId: found.attachment.id,
    expiresAt: found.reservation.expiresAt.toISOString(),
    maxBytes: found.reservation.maxBytes,
    status: found.attachment.status,
    attachment:
      found.attachment.status === 'ready' || found.attachment.status === 'failed'
        ? attachmentDto(found.attachment)
        : null,
  }
}

/** Bounded streaming reader, propagates cancellation and maintains a digest without buffering a whole upload. */
function receiveStream(
  input: ReadableStream<Uint8Array>,
  maxBytes: number,
  controller: AbortController,
) {
  const reader = input.getReader(),
    digest = createHash('sha256')
  let size = 0,
    hash = '',
    ended = false
  const deadline = performance.now() + UPLOAD_LIMITS.receiveMs
  const timer = setTimeout(
    () => controller.abort(new AppError('REQUEST_TIMEOUT', 'Upload timed out')),
    UPLOAD_LIMITS.receiveMs,
  )
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  controller.signal.addEventListener('abort', abort, { once: true })
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(output) {
        let idle: ReturnType<typeof setTimeout> | undefined
        try {
          controller.signal.throwIfAborted()
          const next = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              idle = setTimeout(
                () => reject(new AppError('REQUEST_TIMEOUT', 'Upload stalled')),
                Math.min(UPLOAD_LIMITS.idleMs, Math.max(1, deadline - performance.now())),
              )
            }),
          ])
          controller.signal.throwIfAborted()
          if (next.done) {
            if (!size) throw new AppError('VALIDATION_FAILED', 'Empty file')
            hash = digest.digest('hex')
            ended = true
            output.close()
            return
          }
          size += next.value.byteLength
          if (size > maxBytes) throw new AppError('PAYLOAD_TOO_LARGE', 'Upload exceeds reservation')
          digest.update(next.value)
          output.enqueue(next.value)
        } catch (error) {
          controller.abort(error)
          output.error(error)
        } finally {
          clearTimeout(idle)
        }
      },
      cancel() {
        controller.abort()
      },
    },
    { highWaterMark: 1 },
  )
  return {
    stream,
    result: () => {
      if (!ended) throw new AppError('CONFLICT', 'Upload incomplete')
      return { size, hash }
    },
    dispose() {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', abort)
      void reader.cancel().catch(() => undefined)
    },
  }
}
async function requireUploadAccess(
  tx: import('@chatapp/db').DbOrTx,
  deps: Deps,
  user: Pick<typeof users.$inferSelect, 'id' | 'role'>,
  attachment: Pick<typeof attachments.$inferSelect, 'conversationId' | 'purpose'>,
) {
  if (!attachment.conversationId) return
  const access = await loadAccess(tx, user.id, attachment.conversationId, { lock: true })
  enforce(
    access,
    { userId: user.id, siteRole: user.role },
    attachment.purpose === 'conversation_avatar' ? 'update' : 'send_message',
    deps.clock.now(),
  )
}
export async function receiveUpload(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
  input: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Upload> {
  const store = blobStore(deps)
  const [head] = await deps.db
    .select({ a: attachments })
    .from(uploadReservations)
    .innerJoin(attachments, eq(attachments.id, uploadReservations.attachmentId))
    .where(and(eq(uploadReservations.id, id), eq(uploadReservations.userId, principal.userId)))
  if (!head) throw attachmentMissing()
  const claim = await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal)
    await requireUploadAccess(tx, deps, user, head.a)
    await lockStorage(tx)
    const [reservation] = await tx
      .select()
      .from(uploadReservations)
      .where(and(eq(uploadReservations.id, id), eq(uploadReservations.userId, principal.userId)))
      .for('update')
    if (!reservation) throw attachmentMissing()
    const [attachment] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, reservation.attachmentId))
      .for('update')
    if (
      attachment &&
      ['uploaded', 'processing', 'settled'].includes(reservation.status) &&
      ['processing', 'ready'].includes(attachment.status)
    ) {
      if (attachment.conversationId !== head.a.conversationId)
        throw new AppError('CONFLICT', 'Upload changed')
      const [receipt] = await tx
        .select()
        .from(attachmentObjects)
        .where(
          and(
            eq(attachmentObjects.attachmentId, attachment.id),
            eq(attachmentObjects.variant, 'input'),
          ),
        )
      if (!receipt?.sha256) throw new AppError('CONFLICT', 'Upload receipt missing')
      return {
        reservation,
        attachment,
        storageKey: receipt.storageKey,
        replay: { size: receipt.sizeBytes, hash: receipt.sha256 },
      }
    }
    if (
      !attachment ||
      attachment.messageId ||
      reservation.status !== 'reserved' ||
      reservation.leaseEpoch !== 0 ||
      reservation.expiresAt <= deps.clock.now()
    )
      throw new AppError('CONFLICT', 'Upload cannot receive content')
    const expiresAt = new Date(deps.clock.now().getTime() + UPLOAD_LIMITS.receiveMs)
    const storageKey = `att/${attachment.id}/${attachment.generation}/input`
    await tx
      .update(uploadReservations)
      .set({ leaseEpoch: 1, expiresAt })
      .where(eq(uploadReservations.id, id))
    await tx.insert(attachmentObjects).values({
      attachmentId: attachment.id,
      generation: attachment.generation,
      variant: 'input',
      storageKey,
      deleteAfter: new Date(expiresAt.getTime() + UPLOAD_LIMITS.leaseMs),
    })
    return { reservation, attachment, storageKey, replay: null }
  })
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const received = receiveStream(input, claim.reservation.maxBytes, controller)
  if (claim.replay) {
    try {
      const reader = received.stream.getReader()
      try {
        while (!(await reader.read()).done) {
          /* bounded digest only; accepted objects are never overwritten */
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
      const digest = received.result()
      if (digest.size !== claim.replay.size || digest.hash !== claim.replay.hash)
        throw new AppError('CONFLICT', 'Content differs from accepted upload')
      await inTransaction(deps.db, async (tx) => {
        const user = await lockAndRevalidate(tx, deps, principal)
        await requireUploadAccess(tx, deps, user, claim.attachment)
        const [r] = await tx
          .select()
          .from(uploadReservations)
          .where(eq(uploadReservations.id, id))
          .for('update')
        const [a] = await tx
          .select()
          .from(attachments)
          .where(eq(attachments.id, claim.attachment.id))
        if (
          !r ||
          !a ||
          a.conversationId !== claim.attachment.conversationId ||
          !['uploaded', 'processing', 'settled'].includes(r.status) ||
          !['processing', 'ready'].includes(a.status)
        )
          throw new AppError('CONFLICT', 'Upload no longer active')
      })
      return getUpload(deps, principal, id)
    } finally {
      received.dispose()
      signal?.removeEventListener('abort', abort)
    }
  }
  try {
    await store.put(claim.storageKey, received.stream, controller.signal)
    const { size, hash } = received.result()
    await inTransaction(deps.db, async (tx) => {
      const user = await lockAndRevalidate(tx, deps, principal)
      await requireUploadAccess(tx, deps, user, claim.attachment)
      await lockStorage(tx)
      const [r] = await tx
        .select()
        .from(uploadReservations)
        .where(eq(uploadReservations.id, id))
        .for('update')
      if (r?.status !== 'reserved' || r.leaseEpoch !== 1 || r.expiresAt <= deps.clock.now())
        throw new AppError('CONFLICT', 'Upload no longer owns its reservation')
      await tx
        .update(attachmentObjects)
        .set({ sizeBytes: size, sha256: hash, deleteAfter: null })
        .where(eq(attachmentObjects.storageKey, claim.storageKey))
      await tx
        .update(attachments)
        .set({ status: 'processing', rawSizeBytes: size, version: sql`${attachments.version} + 1` })
        .where(eq(attachments.id, r.attachmentId))
      await tx
        .update(uploadReservations)
        .set({
          status: 'uploaded',
          expiresAt: new Date(deps.clock.now().getTime() + UPLOAD_LIMITS.leaseMs),
        })
        .where(eq(uploadReservations.id, id))
      await enqueueWork(tx, deps, {
        kind: 'media',
        entityId: r.attachmentId,
        dedupeKey: `media:${r.attachmentId}`,
        payload: {},
      })
    })
  } catch (error) {
    await cancelUpload(deps, principal, id).catch(() => undefined)
    throw error
  } finally {
    received.dispose()
    signal?.removeEventListener('abort', abort)
  }
  return getUpload(deps, principal, id)
}
export async function cancelUpload(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<void> {
  await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    await lockStorage(tx)
    const [r] = await tx
      .select()
      .from(uploadReservations)
      .where(and(eq(uploadReservations.id, id), eq(uploadReservations.userId, principal.userId)))
      .for('update')
    if (!r) throw attachmentMissing()
    const [a] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, r.attachmentId))
      .for('update')
    if (!a || a.messageId) throw new AppError('CONFLICT', 'A bound attachment cannot be cancelled')
    if (a.status === 'deleting' || r.status === 'released') return
    // Selected avatars are bound by a live pointer, not by message_id.
    const pointers = await tx.execute(
      sql`select 1 from users where avatar_attachment_id = ${a.id} union all select 1 from conversations where avatar_attachment_id = ${a.id}`,
    )
    if (pointers.length) throw new AppError('CONFLICT', 'A selected avatar cannot be cancelled')
    await retireAttachment(tx, deps, a.id)
  })
}
/** Caller holds user/conversation locks followed by site storage; quota refund is a one-way state transition. */
export async function retireAttachment(
  tx: import('@chatapp/db').DbOrTx,
  deps: Deps,
  id: string,
): Promise<void> {
  const [a] = await tx.select().from(attachments).where(eq(attachments.id, id)).for('update')
  if (!a || a.status === 'deleting') return
  const [r] = await tx
    .select()
    .from(uploadReservations)
    .where(eq(uploadReservations.attachmentId, id))
    .for('update')
  if (!r) throw new Error('attachment reservation missing')
  if (r.status !== 'released') {
    await tx
      .update(users)
      .set({
        storageUsedBytes: sql`${users.storageUsedBytes} - ${a.chargedBytes}`,
        storageReservedBytes: sql`${users.storageReservedBytes} - ${r.status === 'settled' ? 0 : r.reservedBytes}`,
        meVersion: sql`${users.meVersion} + 1`,
      })
      .where(eq(users.id, a.uploaderId))
    await tx
      .update(uploadReservations)
      .set({ status: 'released', leaseEpoch: sql`${uploadReservations.leaseEpoch} + 1` })
      .where(eq(uploadReservations.id, r.id))
    await recordUserChange(tx, deps, {
      userId: a.uploaderId,
      entityType: 'me',
      entityId: a.uploaderId,
    })
  }
  await tx
    .update(attachments)
    .set({
      status: 'deleting',
      chargedBytes: 0,
      generation: sql`${attachments.generation} + 1`,
      version: sql`${attachments.version} + 1`,
      deletedAt: deps.clock.now(),
      deletedMessageId: a.messageId,
      messageId: null,
    })
    .where(eq(attachments.id, id))
  // A stale producer can finish only within its bounded lease. Delay deleting its unique key until then.
  await enqueueHint(tx, deps, {
    event: 'attachment.updated',
    userId: a.uploaderId,
    attachmentId: a.id,
    generation: a.generation + 1,
    version: a.version + 1,
  })
  await tx
    .update(attachmentObjects)
    .set({
      status: 'deleting',
      deleteAfter: new Date(deps.clock.now().getTime() + UPLOAD_LIMITS.leaseMs * 2),
    })
    .where(
      and(
        eq(attachmentObjects.attachmentId, id),
        inArray(attachmentObjects.status, ['staging', 'live']),
      ),
    )
}
