import { z } from 'zod'

export const memoryContentSchema = z
  .string()
  .trim()
  .min(1)
  .refine((v) => [...v].length <= 500, 'At most 500 characters')
export const memorySchema = z.object({
  id: z.uuid(),
  content: memoryContentSchema.nullable(),
  source: z.enum(['user', 'agent']),
  privacyClass: z.enum(['standard', 'byok_private']),
  contentVersion: z.number().int().positive(),
  createdByRunId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
})
export type AgentMemory = z.infer<typeof memorySchema>
export const memoryListSchema = z.object({ memories: z.array(memorySchema) })
export const memoryResponseSchema = z.object({ memory: memorySchema })
export const addMemorySchema = z.strictObject({
  content: memoryContentSchema,
  allowSite: z.boolean().default(false),
})
export const editMemoryPrivacySchema = z.strictObject({
  allowSite: z.boolean(),
  expectedContentVersion: z.number().int().positive(),
})
