import {
  type Attachment,
  type ReserveUpload,
  UPLOAD_LIMITS,
  uploadSchema,
} from '@chatapp/contracts'
import { engine, forScreen } from '@/app/sync.ts'
import { ApiError, api } from '@/lib/api.ts'
import { uploadPollDelay, waitForUpload } from '@/lib/sync/upload-hints.ts'

export async function uploadFile(
  file: Blob,
  input: ReserveUpload,
  signal: AbortSignal,
  progress: (percent: number) => void,
  reserved?: (uploadId: string) => void,
): Promise<Attachment | null> {
  const scope = input.conversationId ?? null
  const ticket = engine.ticket(scope)
  const reservation = await forScreen(scope, () =>
    api('/api/uploads/reservations', {
      method: 'POST',
      json: { ...input, declaredSize: file.size },
      schema: uploadSchema,
      idempotencyKey: crypto.randomUUID(),
      signal,
    }),
  )
  if (!reservation) return null
  reserved?.(reservation.uploadId)
  let upload = await forScreen(scope, () =>
    api(`/api/uploads/${reservation.uploadId}/content`, {
      method: 'PUT',
      body: file,
      onUploadProgress: (percent) => {
        if (engine.isCurrent(ticket) && !signal.aborted) progress(percent)
      },
      signal,
      schema: uploadSchema,
    }),
  )
  if (!upload) return null
  const deadline = performance.now() + UPLOAD_LIMITS.reservationMs
  let attempt = 0,
    retryMs = 0
  while (upload.status === 'processing' || upload.status === 'uploading') {
    await waitForUpload(
      signal,
      Math.max(uploadPollDelay(attempt++), retryMs),
      retryMs ? undefined : reservation.attachmentId,
    )
    if (!engine.isCurrent(ticket)) return null
    if (performance.now() > deadline) throw new ApiError(408, 'REQUEST_TIMEOUT')
    try {
      const next = await forScreen(scope, () =>
        api(`/api/uploads/${reservation.uploadId}`, { schema: uploadSchema, signal }),
      )
      if (!next) return null
      upload = next
      retryMs = 0
    } catch (error) {
      if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
        retryMs = Math.max(1000, (error.retryAfterSeconds ?? 10) * 1000)
        continue
      }
      throw error
    }
    if (!upload) return null
  }
  if (upload.status !== 'ready' || !upload.attachment) throw new ApiError(422, 'VALIDATION_FAILED')
  return upload.attachment
}
