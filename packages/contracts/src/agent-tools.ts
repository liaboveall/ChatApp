import { z } from 'zod'

export const agentToolSchemas = {
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
} as const
export type AgentToolName = keyof typeof agentToolSchemas
