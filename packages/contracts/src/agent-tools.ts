import { z } from 'zod'
import {
  conversationNameSchema,
  messageBodySchema,
  timezoneSchema,
  usernameSchema,
} from './identity.ts'
import { LIMITS } from './limits.ts'
import { memoryContentSchema } from './memories.ts'

/** M4 read-only tools (docs/06 section 4.1). */
export const agentReadToolSchemas = {
  read_conversation: z.strictObject({
    conversationId: z.uuid().optional(),
    beforeSeq: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  read_unread: z.strictObject({ conversationId: z.uuid() }),
  search_messages: z.strictObject({
    query: z.string().trim().min(1).max(200),
    conversationIds: z.array(z.uuid()).max(200).optional(),
    from: z.uuid().optional(),
    after: z.iso.datetime().optional(),
    before: z.iso.datetime().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  get_message: z.strictObject({
    messageId: z.uuid(),
    bodyOffset: z.number().int().min(0).max(20_000).default(0),
    bodyLimit: z.number().int().min(1).max(20_000).default(2000),
  }),
  list_conversations: z.strictObject({
    kind: z.enum(['channel', 'group', 'dm', 'agent']).optional(),
    unreadOnly: z.boolean().optional(),
  }),
  list_members: z.strictObject({ conversationId: z.uuid() }),
  get_user_profile: z
    .strictObject({
      userId: z.uuid().optional(),
      username: z
        .string()
        .regex(/^[a-z0-9_]{3,20}$/)
        .optional(),
    })
    .refine((v) => (v.userId !== undefined) !== (v.username !== undefined)),
  recall_memories: z.strictObject({ query: z.string().trim().min(1).max(200) }),
  semantic_search_messages: z.strictObject({
    query: z.string().trim().min(1).max(200),
    conversationIds: z.array(z.uuid()).max(200).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  }),
} as const

/** Wall-clock minute in the run's time zone; the server resolves it to UTC and never guesses a DST reading (AT-37). */
export const localDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'YYYY-MM-DDTHH:mm')
/** Minutes east of UTC; only used to pick one reading of a repeated local time. */
export const offsetMinutesSchema = z.number().int().min(-840).max(840)
export const reminderTextSchema = z.string().trim().min(1).max(1000)

/**
 * M5a tools with effects (docs/06 section 4.2). Every call crosses the approval boundary; which ones need the person is
 * decided by the server, never by these schemas or the model.
 */
export const agentEffectToolSchemas = {
  send_message: z.strictObject({
    conversationId: z.uuid(),
    body: messageBodySchema,
    replyToId: z.uuid().optional(),
  }),
  schedule_message: z.strictObject({
    conversationId: z.uuid(),
    body: messageBodySchema,
    localDateTime: localDateTimeSchema,
    timezone: timezoneSchema,
    offsetMinutes: offsetMinutesSchema.optional(),
  }),
  create_group: z.strictObject({
    name: conversationNameSchema,
    memberUsernames: z.array(usernameSchema).max(LIMITS.addMembersMax).default([]),
  }),
  invite_members: z.strictObject({
    conversationId: z.uuid(),
    usernames: z.array(usernameSchema).min(1).max(LIMITS.addMembersMax),
  }),
  create_reminder: z.strictObject({
    localDateTime: localDateTimeSchema,
    timezone: timezoneSchema,
    offsetMinutes: offsetMinutesSchema.optional(),
    text: reminderTextSchema,
    conversationId: z.uuid().optional(),
  }),
  cancel_reminder: z.strictObject({ id: z.uuid() }),
  cancel_scheduled_message: z.strictObject({ id: z.uuid() }),
  remember: z.strictObject({ content: memoryContentSchema }),
  forget: z.strictObject({ memoryId: z.uuid() }),
} as const

export const agentToolSchemas = { ...agentReadToolSchemas, ...agentEffectToolSchemas } as const
export type AgentReadToolName = keyof typeof agentReadToolSchemas
export type AgentEffectToolName = keyof typeof agentEffectToolSchemas
export type AgentToolName = keyof typeof agentToolSchemas
export const AGENT_EFFECT_TOOLS = Object.keys(agentEffectToolSchemas) as AgentEffectToolName[]
export const isAgentEffectTool = (name: string): name is AgentEffectToolName =>
  Object.hasOwn(agentEffectToolSchemas, name)
export const isAgentReadTool = (name: string): name is AgentReadToolName =>
  Object.hasOwn(agentReadToolSchemas, name)
