/** Private, bounded worker ↔ media IPC (D-081, D-176). No names, URLs, commands, paths or credentials. */
import { z } from 'zod'
import { uuidSchema } from './identity.ts'

const MiB = 1024 * 1024
export const MEDIA_LIMITS = {
  protocolVersion: 1,
  headerBytes: 8 * 1024,
  inputBytes: 100 * MiB,
  imageBytes: 20 * MiB,
  variantBytes: 10 * MiB,
  maxSide: 16384,
  staticPixels: 40_000_000,
  animatedPixels: 100_000_000,
  frames: 200,
  durationMs: 30 * 60 * 1000,
  taskMs: 60_000,
  chunkBytes: 64 * 1024,
} as const

export const mediaDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const mediaIdentitySchema = z.strictObject({
  v: z.literal(MEDIA_LIMITS.protocolVersion),
  jobId: uuidSchema,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  nonce: mediaDigestSchema,
})
export const mediaOperationSchema = z.enum(['image', 'avatar', 'video'])
export type MediaOperation = z.infer<typeof mediaOperationSchema>

export const mediaRequestSchema = mediaIdentitySchema
  .extend({
    operation: mediaOperationSchema,
    inputBytes: z.number().int().positive().max(MEDIA_LIMITS.inputBytes),
    inputSha256: mediaDigestSchema,
    maxOutputBytes: z.number().int().positive().max(MEDIA_LIMITS.inputBytes),
  })
  .superRefine((job, context) => {
    if (job.operation !== 'video') {
      for (const field of ['inputBytes', 'maxOutputBytes'] as const) {
        if (job[field] > MEDIA_LIMITS.imageBytes)
          context.addIssue({ code: 'custom', path: [field], message: 'Image limit exceeded' })
      }
    }
  })
export type MediaRequest = z.infer<typeof mediaRequestSchema>
export type MediaIdentity = z.infer<typeof mediaIdentitySchema>

export const mediaVariantSchema = z.enum(['original', 'thumb', 'preview'])
export type MediaVariant = z.infer<typeof mediaVariantSchema>
export const mediaMimeSchema = z.enum([
  'image/webp',
  'image/gif',
  'video/mp4',
  'application/octet-stream',
])
const dimension = z.number().int().positive().max(MEDIA_LIMITS.maxSide).nullable()
export const mediaFileSchema = z
  .strictObject({
    variant: mediaVariantSchema,
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_LIMITS.inputBytes),
    sha256: mediaDigestSchema,
    width: dimension,
    height: dimension,
  })
  .refine((file) => (file.width === null) === (file.height === null), {
    message: 'Dimensions must be a pair',
  })
export type MediaFile = z.infer<typeof mediaFileSchema>

export const mediaSuccessSchema = mediaIdentitySchema
  .extend({
    status: z.literal('ok'),
    kind: z.enum(['image', 'video', 'file']),
    mime: mediaMimeSchema,
    width: dimension,
    height: dimension,
    durationMs: z.number().int().nonnegative().max(MEDIA_LIMITS.durationMs).nullable(),
    metadataCleared: z.boolean(),
    thumbhash: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
      .nullable(),
    files: z.array(mediaFileSchema).min(1).max(3),
  })
  .superRefine((result, context) => {
    const reject = (message: string) => context.addIssue({ code: 'custom', message })
    const original = result.files.find((file) => file.variant === 'original')
    if (!original || new Set(result.files.map((file) => file.variant)).size !== result.files.length)
      reject('Exactly one original and no duplicate variants')
    if (
      original &&
      (original.mime !== result.mime ||
        original.width !== result.width ||
        original.height !== result.height)
    )
      reject('Main metadata must agree with the original')
    if (
      result.files.reduce((sum, file) => sum + (file.variant === 'original' ? 0 : file.bytes), 0) >
      MEDIA_LIMITS.variantBytes
    )
      reject('Variant byte limit exceeded')
    if (result.kind === 'image') {
      if (
        !result.mime.startsWith('image/') ||
        !result.metadataCleared ||
        result.width === null ||
        result.height === null ||
        result.durationMs !== null ||
        !result.thumbhash ||
        result.files.length !== 3 ||
        (original?.bytes ?? 0) > MEDIA_LIMITS.imageBytes ||
        result.files.some((file) => !file.mime.startsWith('image/') || file.width === null)
      )
        reject('Invalid image metadata or variants')
    } else if (result.kind === 'video') {
      if (
        result.mime !== 'video/mp4' ||
        !result.metadataCleared ||
        result.width === null ||
        result.height === null ||
        result.durationMs === null ||
        result.thumbhash !== null ||
        result.files.length !== 1
      )
        reject('Invalid video metadata')
    } else if (
      result.mime !== 'application/octet-stream' ||
      result.metadataCleared ||
      result.width !== null ||
      result.height !== null ||
      result.durationMs !== null ||
      result.thumbhash !== null ||
      result.files.length !== 1
    ) {
      reject('Uncleaned fallback must be download-only')
    }
  })
export type MediaSuccess = z.infer<typeof mediaSuccessSchema>
export const mediaFailureCodeSchema = z.enum([
  'invalid_request',
  'invalid_input',
  'input_limit',
  'output_limit',
  'unsupported',
  'timeout',
  'processor_failed',
  'busy',
])
export type MediaFailureCode = z.infer<typeof mediaFailureCodeSchema>
export const mediaFailureSchema = mediaIdentitySchema.extend({
  status: z.literal('failed'),
  code: mediaFailureCodeSchema,
})
export const mediaResponseSchema = z.union([mediaSuccessSchema, mediaFailureSchema])
export type MediaResponse = z.infer<typeof mediaResponseSchema>

export function mediaIdentity(request: MediaIdentity): MediaIdentity {
  return {
    v: request.v,
    jobId: request.jobId,
    generation: request.generation,
    nonce: request.nonce,
  }
}

/** Length-prefix plus UTF-8 JSON; the body is streamed separately, never embedded in JSON. */
export function encodeMediaHeader(value: MediaRequest | MediaResponse): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(value))
  if (json.byteLength === 0 || json.byteLength > MEDIA_LIMITS.headerBytes)
    throw new Error('Invalid media header length')
  const frame = new Uint8Array(4 + json.byteLength)
  new DataView(frame.buffer).setUint32(0, json.byteLength)
  frame.set(json, 4)
  return frame
}

function decodeHeader(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_LIMITS.headerBytes)
    throw new Error('Invalid media header length')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
}
export function decodeMediaRequest(bytes: Uint8Array): MediaRequest {
  return mediaRequestSchema.parse(decodeHeader(bytes))
}
export function decodeMediaResponse(bytes: Uint8Array): MediaResponse {
  return mediaResponseSchema.parse(decodeHeader(bytes))
}
