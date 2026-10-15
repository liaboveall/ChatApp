import { z } from 'zod'
export const processHealthSchema = z
  .object({
    format: z.literal(1),
    service: z.enum(['worker', 'api']),
    pid: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
    eventLoop: z
      .object({
        samples: z.number().int().nonnegative(),
        p95Ms: z.number().finite().nonnegative(),
        p99Ms: z.number().finite().nonnegative(),
        maxMs: z.number().finite().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()
export const OPERATION_PROBLEMS = [
  'backup_missing',
  'backup_age_warning',
  'backup_rpo_exceeded',
  'backup_latest_failed',
  'backup_clock_skew',
  'deletion_pending_over_minute',
  'journal_integrity_or_availability',
  'journal_watermark_ahead',
  'physical_delete_over_hour',
  'dead_letters',
  'storage_low_free_space',
  'storage_capacity_unavailable',
] as const
export const operationsHealthSchema = z
  .object({
    status: z.enum(['healthy', 'attention']),
    backupAgeSeconds: z.number().int().nullable(),
    problems: z.array(z.enum(OPERATION_PROBLEMS)).max(OPERATION_PROBLEMS.length),
  })
  .strict()
export type OperationsHealth = z.infer<typeof operationsHealthSchema>
export const operationsAlertStateSchema = z
  .object({
    signature: z.string().regex(/^[a-f0-9]{64}$/),
    sentAt: z.number().int().nonnegative(),
    attention: z.boolean(),
  })
  .strict()
export const containerObservationSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    running: z.boolean(),
    health: z.string(),
    project: z.string(),
    owner: z.string(),
    release: z.string(),
    service: z.string(),
  })
  .strict()
export type ContainerObservation = z.infer<typeof containerObservationSchema>
export const watchdogStateSchema = z.record(
  z.string(),
  z
    .object({
      id: z.string(),
      failures: z.number().int().nonnegative(),
      restarts: z.array(z.number()),
      observedAt: z.number(),
    })
    .strict(),
)
export type WatchdogEntry = z.infer<typeof watchdogStateSchema>[string]
export const deploymentIdentitySchema = z
  .object({
    CHATAPP_OWNER: z.uuid(),
    CHATAPP_PROJECT: z.string().regex(/^chatapp-[a-f0-9]{8}$/),
    APPLICATION_SOURCE_HASH: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough()
export const releaseManifestSchema = z
  .object({
    format: z.literal(1),
    APPLICATION_SHA: z.string().regex(/^[a-f0-9]{40}$/),
    APPLICATION_SOURCE_HASH: z.string().regex(/^[a-f0-9]{64}$/),
    dirty: z.boolean(),
    baselineShaOnly: z.boolean(),
    architecture: z.enum(['x64', 'arm64']),
    images: z.record(
      z.string().regex(/^(server|media|ops|postgres|valkey|garage|nginx)$/),
      z.string().regex(/^sha256:[a-f0-9]{64}$/),
    ),
    artifacts: z.array(
      z
        .object({
          name: z.string().regex(/^[a-z.-]+$/),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    sourceFiles: z.array(
      z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    ),
  })
  .strict()
export const backupInventoryReceiptSchema = z
  .object({
    status: z.literal('verified'),
    snapshots: z.number().int().nonnegative(),
    inventory: z.array(
      z
        .object({
          snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
          runId: z.uuid(),
          snapshotAt: z.iso.datetime(),
          sourceHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .nullable(),
          objectCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()
export const restoreDownloadReceiptSchema = z
  .object({
    status: z.literal('download_verified'),
    payload: z.string().regex(/^\/var\/lib\/chatapp\/restore\/[a-zA-Z0-9_/-]+\/payload$/),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
