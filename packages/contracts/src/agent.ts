import { z } from 'zod'
import { delegationStatusSchema } from './enums.ts'
import { timezoneSchema } from './identity.ts'
import { messageSchema, usersDictionarySchema } from './messages.ts'
import { userSummarySchema } from './users.ts'

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
  /** M5a: an effect committed (regeneration is then refused) / the run waits for the caller's decision. */
  hasEffects: z.boolean(),
  pendingApproval: z.boolean(),
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
  type: z.enum(['model', 'tool_call', 'tool_result', 'error', 'approval']),
  toolName: z.string().nullable(),
  status: z.enum(['pending', 'done', 'failed']).nullable(),
  payload: z.unknown(),
  createdAt: z.iso.datetime(),
})
const isoDate = z.iso.datetime()
export const agentApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired'])
export const conversationRefSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['channel', 'group', 'dm', 'agent']),
  /** null for a direct message; the client names it after the other person (`peer`). */
  name: z.string().nullable(),
  peer: userSummarySchema.nullable(),
})
export type ConversationRef = z.infer<typeof conversationRefSchema>
/** A wall-clock reading and what it means in UTC; two candidates when the local time repeats (AT-37). */
export const scheduleTimeSchema = z.object({
  localDateTime: z.string(),
  timezone: z.string(),
  candidates: z.array(z.object({ at: isoDate, offsetMinutes: z.number().int() })),
  /** The reading that will be used; null while the person has to choose between two candidates. */
  chosen: z.object({ at: isoDate, offsetMinutes: z.number().int() }).nullable(),
})
export type ScheduleTime = z.infer<typeof scheduleTimeSchema>
/**
 * What the approval card shows, rebuilt on every read with the caller's current access: a destination they lost is
 * `null`, never its stale name (docs/02 section 6, A4).
 */
export const approvalPreviewSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('send_message'),
    conversation: conversationRefSchema.nullable(),
    body: z.string(),
  }),
  z.object({
    tool: z.literal('schedule_message'),
    conversation: conversationRefSchema.nullable(),
    body: z.string(),
    time: scheduleTimeSchema,
  }),
  z.object({
    tool: z.literal('create_group'),
    name: z.string(),
    members: z.array(userSummarySchema),
    unavailable: z.array(z.string()),
  }),
  z.object({
    tool: z.literal('invite_members'),
    conversation: conversationRefSchema.nullable(),
    members: z.array(userSummarySchema),
    unavailable: z.array(z.string()),
  }),
  z.object({
    tool: z.literal('create_reminder'),
    text: z.string(),
    time: scheduleTimeSchema,
    conversation: conversationRefSchema.nullable(),
  }),
  z.object({ tool: z.literal('cancel_reminder'), targetId: z.uuid() }),
  z.object({ tool: z.literal('cancel_scheduled_message'), targetId: z.uuid() }),
  z.object({
    tool: z.literal('remember'),
    content: z.string(),
    privacyClass: z.enum(['standard', 'byok_private']),
  }),
  z.object({ tool: z.literal('forget'), targetId: z.uuid() }),
])
export type ApprovalPreview = z.infer<typeof approvalPreviewSchema>
export const agentApprovalSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  toolName: z.string(),
  status: agentApprovalStatusSchema,
  /** Why it ended without the person: `invalid:<code>`, `cancelled`, `expired`, `context_changed`. */
  reason: z.string().nullable(),
  /** false when the server decided it (reminders, cancellations, invalid requests). */
  required: z.boolean(),
  /** null once the run content was purged (30 days). */
  preview: approvalPreviewSchema.nullable(),
  edited: z.boolean(),
  stateVersion: count,
  /** The reply segment that asked, and the stable step whose effect (if any) is in `effects`. */
  resumeSeq: count,
  stepIndex: count,
  expiresAt: isoDate,
  decidedAt: isoDate.nullable(),
  createdAt: isoDate,
})
export type AgentApproval = z.infer<typeof agentApprovalSchema>
export const agentEffectSchema = z.object({
  stepIndex: count,
  toolName: z.string(),
  entityType: z.string().nullable(),
  entityId: z.uuid().nullable(),
  /** Ids and result codes only; the content is read through its own authorized endpoint. */
  result: z.record(z.string(), z.unknown()),
  createdAt: isoDate,
})
export type AgentEffect = z.infer<typeof agentEffectSchema>
export const agentRunDetailSchema = z.object({
  run: agentRunSchema,
  steps: z.array(agentStepSchema),
  approvals: z.array(agentApprovalSchema),
  effects: z.array(agentEffectSchema),
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
  /** Where a new segment's calls would go now: the person's own key or the site allowance (M5a). */
  keySource: z.enum(['site', 'user']),
  /** Today's usage of the person's own key; it never touches the site accounts. */
  own: z.object({ inputTokens: count, outputTokens: count, runCount: count }),
})
export type AgentUsage = z.infer<typeof agentUsageSchema>

export const agentApprovalDecisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  /** Changed arguments of the same tool; validated like the model's, then frozen with their hash. */
  editedArgs: z.record(z.string(), z.unknown()).optional(),
  expectedStateVersion: z.number().int().min(1),
})
export type AgentApprovalDecision = z.infer<typeof agentApprovalDecisionSchema>
export const agentApprovalResponseSchema = z.object({
  approval: agentApprovalSchema,
  run: agentRunSchema,
})
export const agentApprovalListQuerySchema = z.object({
  status: agentApprovalStatusSchema.default('pending'),
})
export const agentApprovalListSchema = z.object({ approvals: z.array(agentApprovalSchema) })

/** Switching where a private assistant conversation sends its calls opens a blank segment (docs/06 section 3.1). */
export const agentKeySourceRequestSchema = z.strictObject({
  keySource: z.enum(['site', 'user']),
})
export const agentContextResponseSchema = z.object({
  conversationId: z.uuid(),
  contextEpoch: z.uuid(),
  stateVersion: count,
  historyFromSeq: count,
  keySource: z.enum(['site', 'user']),
  readScope: agentReadScopeSchema,
})
export type AgentContext = z.infer<typeof agentContextResponseSchema>

export const TASK_STATUSES = ['scheduled', 'sent', 'cancelled', 'failed'] as const
export const taskStatusSchema = z.enum(TASK_STATUSES)
const taskBase = {
  id: z.uuid(),
  version: count,
  status: taskStatusSchema,
  /** The UTC instant agreed when it was created; a later time zone change never moves it (INV-30). */
  at: isoDate,
  timezone: z.string(),
  localDateTime: z.string(),
  offsetMinutes: z.number().int(),
  createdAt: isoDate,
  finishedAt: isoDate.nullable(),
  errorCode: z.string().nullable(),
  createdByRunId: z.uuid().nullable(),
  /** The device that authorized it (no credential), and the state of that authority. */
  origin: z.object({ id: z.uuid(), current: z.boolean() }).nullable(),
  delegation: z.object({ status: delegationStatusSchema, expiresAt: isoDate }).nullable(),
}
export const reminderSchema = z.object({
  ...taskBase,
  /** null once cancelled, or 30 days after it ended. */
  text: z.string().nullable(),
  conversation: conversationRefSchema.nullable(),
})
export type Reminder = z.infer<typeof reminderSchema>
export const scheduledMessageSchema = z.object({
  ...taskBase,
  body: z.string().nullable(),
  conversation: conversationRefSchema.nullable(),
  sentMessageId: z.uuid().nullable(),
})
export type ScheduledMessage = z.infer<typeof scheduledMessageSchema>
export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type TaskListQuery = z.infer<typeof taskListQuerySchema>
export const reminderListSchema = z.object({
  reminders: z.array(reminderSchema),
  nextCursor: z.string().nullable(),
})
export const scheduledMessageListSchema = z.object({
  scheduledMessages: z.array(scheduledMessageSchema),
  nextCursor: z.string().nullable(),
})
export const reminderResponseSchema = z.object({ reminder: reminderSchema })
export const scheduledMessageResponseSchema = z.object({ scheduledMessage: scheduledMessageSchema })

/** The person's own DeepSeek key as they may see it: never the key, only its last four characters (SEC-26). */
export const aiKeySchema = z.object({
  provider: z.literal('deepseek'),
  last4: z.string(),
  status: z.enum(['active', 'invalid']),
  invalidReason: z.enum(['invalid', 'insufficient_balance']).nullable(),
  lastVerifiedAt: isoDate.nullable(),
  updatedAt: isoDate,
})
export type AiKey = z.infer<typeof aiKeySchema>
export const aiKeyResponseSchema = z.object({ aiKey: aiKeySchema.nullable() })
export const putAiKeyRequestSchema = z.strictObject({
  provider: z.literal('deepseek').default('deepseek'),
  /** Printable ASCII only; trimmed, never logged or echoed. */
  key: z
    .string()
    .trim()
    .min(8)
    .max(256)
    .regex(/^[\x21-\x7e]+$/),
})
export type PutAiKeyRequest = z.infer<typeof putAiKeyRequestSchema>
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
      type: 'summary'
      id: string
      contextEpoch: string
      summarizedThroughSeq: number
      expiresAt: string
      privacyClass: 'standard' | 'byok_private'
    }
  | {
      type: 'memory'
      id: string
      contentVersion: number
      privacyClass: 'standard' | 'byok_private'
    }
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

/** Administrators' run list and detail (docs/05 section 3.7, INV-15, A7): content only for site-key runs in retention. */
export const adminAgentRunQuerySchema = z.object({
  userId: z.uuid().optional(),
  keySource: z.enum(['site', 'user']).optional(),
  status: agentRunStatusSchema.optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type AdminAgentRunQuery = z.infer<typeof adminAgentRunQuerySchema>
export const adminAgentRunListSchema = z.object({
  runs: z.array(agentRunSchema),
  nextCursor: z.string().nullable(),
})
export const adminAgentRunDetailSchema = z.object({
  run: agentRunSchema,
  /** `own_key`: only metadata exists for administrators; `purged`: the 30-day content retention ended. */
  content: z.discriminatedUnion('available', [
    z.object({
      available: z.literal('site_key'),
      steps: z.array(agentStepSchema),
      /** The full model history as stored for resumption. */
      history: z.array(z.unknown()),
      approvals: z.array(agentApprovalSchema),
    }),
    z.object({ available: z.literal('own_key') }),
    z.object({ available: z.literal('purged') }),
  ]),
})
export type AdminAgentRunDetail = z.infer<typeof adminAgentRunDetailSchema>
