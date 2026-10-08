import { z } from 'zod'
import { timezoneSchema } from './identity.ts'
import { messageSchema, usersDictionarySchema } from './messages.ts'

export const agentModeSchema = z.enum(['fast', 'deep'])
export const agentReadScopeSchema = z.enum(['current_conversation', 'all_accessible'])
export const agentRunStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
])
const count = z.number().int().nonnegative()
export const agentRunRequestSchema = z.strictObject({
  trigger: z.enum(['agent_chat', 'panel', 'command']),
  conversationId: z.uuid().optional(),
  contextConversationId: z.uuid().optional(),
  /** Start a separate panel session while retaining its history. */
  newConversation: z.boolean().optional(),
  prompt: z.string().trim().min(1).max(20_000),
  mode: agentModeSchema.default('fast'),
  scope: z.enum(['current', 'all']).optional(),
  attachmentIds: z.array(z.uuid()).max(4).default([]),
  timezone: timezoneSchema,
})
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>
export const agentRunSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  trigger: z.string(),
  conversationId: z.uuid().nullable(),
  contextConversationId: z.uuid().nullable(),
  sourceMessageId: z.uuid().nullable(),
  outputMessageId: z.uuid().nullable(),
  status: agentRunStatusSchema,
  mode: agentModeSchema,
  provider: z.string(),
  model: z.string(),
  actualModel: z.string().nullable(),
  keySource: z.enum(['site', 'user']),
  readScope: agentReadScopeSchema,
  privacyClass: z.enum(['standard', 'byok_private']),
  contextEpoch: z.uuid(),
  stateVersion: count,
  resumeSeq: count,
  stepCount: count,
  regeneratedFromRunId: z.uuid().nullable(),
  usage: z.object({
    inputTokens: count,
    outputTokens: count,
    cachedTokens: count,
    costUsd: z.string(),
  }),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
})
export type AgentRun = z.infer<typeof agentRunSchema>
export const agentStepSchema = z.object({
  index: count,
  type: z.enum(['model', 'tool_call', 'tool_result', 'error']),
  toolName: z.string().nullable(),
  status: z.enum(['pending', 'done', 'failed']).nullable(),
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
})
export const agentRunDetailSchema = z.object({
  run: agentRunSchema,
  steps: z.array(agentStepSchema),
})
export type AgentRunDetail = z.infer<typeof agentRunDetailSchema>
export const agentRunResponseSchema = z.object({ run: agentRunSchema })
export const agentUsageSchema = z.object({
  provider: z.string(),
  day: z.string(),
  month: z.string(),
  daily: z.object({
    limit: count,
    settled: count,
    reserved: count,
    unknown: count,
    available: count,
    resetAt: z.iso.datetime(),
  }),
  monthly: z.object({
    limitMicroUsd: count,
    settledMicroUsd: count,
    reservedMicroUsd: count,
    unknownMicroUsd: count,
    availableMicroUsd: count,
    resetAt: z.iso.datetime(),
  }),
  warning: z.boolean(),
  paused: z.boolean(),
})
export type AgentUsage = z.infer<typeof agentUsageSchema>
export const messageSearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(200),
  conversationId: z.uuid().optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type MessageSearchQuery = z.infer<typeof messageSearchQuerySchema>
export const messageSearchResponseSchema = z.object({
  messages: z.array(messageSchema),
  users: usersDictionarySchema,
  nextCursor: z.string().nullable(),
})
export type MessageSearchResponse = z.infer<typeof messageSearchResponseSchema>

/** A manifest is authority and version information, never another copy of message text. */
export type AgentSource =
  | { type: 'user'; id: string; profileVersion: number }
  | {
      type: 'conversation'
      id: string
      membershipId: string
      membershipVersion: number
      visibleFromSeq: number
    }
  | {
      type: 'message'
      id: string
      conversationId: string
      contentVersion: number
      privacyClass: 'standard' | 'byok_private'
    }
  | {
      type: 'attachment'
      id: string
      conversationId: string
      version: number
      generation: number
      privacyClass: 'standard' | 'byok_private'
    }
