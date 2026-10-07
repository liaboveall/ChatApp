/** The bounded subset requested from ffprobe. Never pass probe strings back as arguments. */
import { z } from 'zod'

export const MEDIA_PROBE_LIMITS = {
  jsonBytes: 64 * 1024,
  streams: 16,
  chapters: 256,
  tags: 64,
  tagValue: 4096,
} as const

const shortText = z.string().min(1).max(128)
const duration = z.union([z.string().regex(/^\d{1,9}(?:\.\d{1,9})?$/), z.literal('N/A')])
const tags = z
  .record(shortText, z.string().max(MEDIA_PROBE_LIMITS.tagValue))
  .refine((value) => Object.keys(value).length <= MEDIA_PROBE_LIMITS.tags)
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const dimension = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const mediaProbeStreamSchema = z.strictObject({
  index,
  codec_type: z.enum(['video', 'audio', 'subtitle', 'data', 'attachment', 'unknown']),
  codec_name: shortText.optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  duration: duration.optional(),
  disposition: z.strictObject({ attached_pic: z.union([z.literal(0), z.literal(1)]) }).optional(),
  tags: tags.optional(),
  side_data_list: z
    .array(
      z.strictObject({
        side_data_type: shortText,
        rotation: z.number().min(-360).max(360).optional(),
      }),
    )
    .max(16)
    .optional(),
})
export type MediaProbeStream = z.infer<typeof mediaProbeStreamSchema>

export const mediaProbeSchema = z.strictObject({
  streams: z.array(mediaProbeStreamSchema).max(MEDIA_PROBE_LIMITS.streams),
  format: z.strictObject({
    format_name: shortText,
    duration: duration.optional(),
    tags: tags.optional(),
  }),
  chapters: z
    .array(z.strictObject({ id: index, tags: tags.optional() }))
    .max(MEDIA_PROBE_LIMITS.chapters)
    .optional(),
  programs: z.array(z.strictObject({})).max(0).optional(),
  stream_groups: z.array(z.strictObject({})).max(0).optional(),
})
export type MediaProbe = z.infer<typeof mediaProbeSchema>
