import { z } from 'zod'
export const benchmarkProfileSchema = z.enum(['smoke', 'full'])
export const loadControllerSchema = z
  .object({
    distribution: z.enum(['normal', 'hot']).default('normal'),
    clientMatrix: z.boolean(),
    sourceIps: z.array(z.ipv4().or(z.ipv6())).max(128).default([]),
  })
  .strict()
export const loadTargetsSchema = z
  .object({
    small: z.array(z.uuid()).min(1).max(200),
    medium: z.array(z.uuid()).min(1).max(200),
    large: z.array(z.uuid()).min(1).max(200),
  })
  .strict()
export const loadFixtureSchema = z
  .object({
    format: z.literal(1),
    runId: z.uuid(),
    origin: z.url(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    profile: benchmarkProfileSchema,
    hotConversationId: z.uuid().optional(),
    dataset: z
      .object({
        users: z.number().int().positive(),
        messages: z.number().int().positive(),
        conversations: z.number().int().positive(),
        objects: z.number().int().nonnegative(),
        objectBytes: z.number().int().nonnegative(),
      })
      .strict(),
    users: z
      .array(
        z
          .object({
            userId: z.uuid(),
            conversationId: z.uuid(),
            targets: loadTargetsSchema.optional(),
            cookie: z
              .string()
              .min(1)
              .max(8192)
              .refine((value) => !/[\r\n]/.test(value)),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
export type LoadFixture = z.infer<typeof loadFixtureSchema>
/** Deterministic network pacing for mock providers; configuration rejects these knobs outside APP_ENV=test. */
export const mockModelStreamSchema = z
  .object({
    chunkChars: z.coerce.number().int().min(1).max(80).default(80),
    chunkDelayMs: z.coerce.number().int().min(1).max(1000).default(20),
  })
  .strict()
export type MockModelStream = z.infer<typeof mockModelStreamSchema>
/** Public model files and generated image bytes consumed only by the ownership-verified native test harness. */
export const mixedProbeInputSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(200)
              .regex(/^[A-Za-z0-9_./-]+$/)
              .refine((path) => !path.startsWith('/') && !path.split('/').includes('..')),
            data: z
              .string()
              .max(64 * 1024 * 1024)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/),
          })
          .strict(),
      )
      .max(32),
    png: z.string().max(1024 * 1024),
    gif: z.string().max(1024 * 1024),
    controlId: z.uuid().optional(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    seconds: z.number().int().min(30).max(2100).default(30),
  })
  .strict()
