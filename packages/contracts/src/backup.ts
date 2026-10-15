import { z } from 'zod'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const backupObjectSchema = z
  .object({
    key: z
      .string()
      .regex(/^att\/[A-Za-z0-9_./-]+$/)
      .max(512)
      .refine((value) => !value.split('/').includes('..')),
    size: nonnegative,
    sha256: hash,
  })
  .strict()
export type BackupObject = z.infer<typeof backupObjectSchema>
export const backupManifestSchema = z
  .object({
    format: z.literal(1),
    runId: z.uuid(),
    epoch: z.uuid(),
    applicationSha: z.string().regex(/^[a-f0-9]{40}$/),
    applicationSourceHash: hash.optional(),
    schemaHash: hash,
    snapshotAt: z.iso.datetime(),
    journal: z.object({ seq: nonnegative, hash }).strict(),
    database: z.object({ size: nonnegative, sha256: hash }).strict(),
    objects: z.array(backupObjectSchema),
    keyVersions: z.array(z.number().int().positive()).min(1),
    recoveryFiles: z
      .array(z.object({ name: z.string().regex(/^[a-z0-9-]+\.json$/), sha256: hash }).strict())
      .min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.objects.map((object) => object.key)).size !== value.objects.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate backup object' })
  })
export type BackupManifest = z.infer<typeof backupManifestSchema>
