/** WebSocket outer structure and close codes (docs/05 section 4). Writes never go over WebSocket. */
import { z } from 'zod'
import { presenceStatusSchema } from './enums.ts'
import { LIMITS } from './limits.ts'

export const WS_PROTOCOL_VERSION = 1

export const WS_CLOSE = {
  /** Not signed in, or the session was revoked/expired. Clients must not reconnect. */
  UNAUTHENTICATED: 4401,
  /** Origin not allowed. Clients must not reconnect. */
  ORIGIN_NOT_ALLOWED: 4403,
  /** Heartbeat timeout. Reconnect immediately. */
  HEARTBEAT_TIMEOUT: 4408,
  /** Too many connections for the user; the oldest one is closed. */
  TOO_MANY_CONNECTIONS: 4409,
  /** Client sent too fast. Back off, then reconnect. */
  TOO_MANY_MESSAGES: 4429,
  /** Server restarting. */
  SERVER_RESTART: 1012,
  /** A dependency is unavailable or the send buffer overflowed. Back off, then reconnect. */
  TRY_AGAIN_LATER: 1013,
} as const

/** Topics are routes chosen by the server from the current relations; naming one is never an authorization (SEC-03). */
export const convTopic = (conversationId: string): string => `conv:${conversationId}`
export const userTopic = (userId: string): string => `user:${userId}`
export const presenceTopic = (userId: string): string => `presence:${userId}`

const envelope = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({
    v: z.literal(WS_PROTOCOL_VERSION),
    type: z.literal(type),
    topic: z.string().optional(),
    data,
  })

const count = z.number().int().min(0)

export const wsHelloSchema = envelope(
  'hello',
  z.object({
    connectionId: z.uuid(),
    userId: z.uuid(),
    authEpoch: z.number().int(),
    restoreEpoch: z.string(),
    serverTime: z.iso.datetime(),
    heartbeatMs: z.number().int(),
  }),
)
export const wsPongSchema = envelope('pong', z.object({ serverTime: z.iso.datetime() }))
export const wsErrorSchema = envelope('error', z.object({ code: z.string(), message: z.string() }))

/**
 * Ordinary events are hints without content: ids and versions only. The client reads what changed over HTTP, which
 * projects it for that person (docs/03 section 6, SEC-27).
 */
export const wsMessageChangedSchema = envelope(
  'message.changed',
  z.object({ conversationId: z.uuid(), messageId: z.uuid(), changeSeq: count }),
)
/** Shared metadata (name, description, settings, member count, archive) of a conversation changed. */
export const wsConversationChangedSchema = envelope(
  'conversation.changed',
  z.object({ conversationId: z.uuid(), metadataVersion: count }),
)
export const wsMemberChangedSchema = envelope(
  'member.changed',
  z.object({ conversationId: z.uuid(), membershipVersion: count }),
)
/** My own log has news: my conversations, my settings, my read position, messages I hid. */
export const wsAttachmentUpdatedSchema = envelope(
  'attachment.updated',
  z.object({ attachmentId: z.uuid(), generation: count, version: count }),
)
export const wsUserChangedSchema = envelope('user.changed', z.object({ userChangeSeq: count }))
export const agentDeltaSchema = z.object({
  conversationId: z.uuid(),
  runId: z.uuid(),
  messageId: z.uuid(),
  resumeSeq: count,
  leaseEpoch: count,
  index: count,
  streamRevision: count,
  text: z.string().max(20_000),
})
export type AgentDelta = z.infer<typeof agentDeltaSchema>
export const wsAgentDeltaSchema = envelope('agent.delta', agentDeltaSchema)
export const wsAgentRunUpdatedSchema = envelope(
  'agent.run.updated',
  z.object({ runId: z.uuid(), stateVersion: count }),
)
/** One of my reminders or scheduled messages changed; the lists are read over HTTP (M5a). */
export const wsTaskChangedSchema = envelope(
  'task.changed',
  z.object({
    taskType: z.enum(['reminder', 'scheduled_message']),
    taskId: z.uuid(),
    version: count,
  }),
)
/** My membership in a conversation ended; the cache is cleared once a newer removal tombstone is confirmed. */
export const wsConversationRemovedSchema = envelope(
  'conversation.removed',
  z.object({ conversationId: z.uuid(), userChangeSeq: count }),
)
export const wsTypingSchema = envelope(
  'typing',
  z.object({
    conversationId: z.uuid(),
    userId: z.uuid(),
    state: z.enum(['start', 'stop']),
    expiresInMs: count,
  }),
)

export const presenceEntrySchema = z.object({
  userId: z.uuid(),
  status: presenceStatusSchema,
  lastSeenAt: z.iso.datetime().nullable(),
})
export type PresenceEntry = z.infer<typeof presenceEntrySchema>

export const wsPresenceSchema = envelope('presence', presenceEntrySchema)
export const wsPresenceSnapshotSchema = envelope(
  'presence.snapshot',
  z.object({ users: z.array(presenceEntrySchema) }),
)

export const wsServerMessageSchema = z.discriminatedUnion('type', [
  wsHelloSchema,
  wsPongSchema,
  wsErrorSchema,
  wsMessageChangedSchema,
  wsConversationChangedSchema,
  wsMemberChangedSchema,
  wsUserChangedSchema,
  wsAgentDeltaSchema,
  wsAgentRunUpdatedSchema,
  wsTaskChangedSchema,
  wsAttachmentUpdatedSchema,
  wsConversationRemovedSchema,
  wsTypingSchema,
  wsPresenceSchema,
  wsPresenceSnapshotSchema,
])
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>

const clientEnvelope = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ v: z.literal(WS_PROTOCOL_VERSION), type: z.literal(type), data })

/** Client messages carry no topic (docs/05 section 4.3). */
export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(WS_PROTOCOL_VERSION),
    type: z.literal('ping'),
    data: z.object({}).default({}),
  }),
  /** At most once per `typingMinIntervalMs` per conversation; ignored for conversations I am not in. */
  clientEnvelope(
    'typing',
    z.object({ conversationId: z.uuid(), state: z.enum(['start', 'stop']) }),
  ),
  /** Replaces the whole set of people whose presence I follow; answered with a `presence.snapshot`. */
  clientEnvelope(
    'presence.watch',
    z.object({ userIds: z.array(z.uuid()).max(LIMITS.presenceWatchMax) }),
  ),
  clientEnvelope('presence.activity', z.object({ state: z.enum(['active', 'idle']) })),
  /** The conversation being looked at and whether the page is in the foreground; only ever suppresses notifications. */
  clientEnvelope(
    'focus',
    z.object({ conversationId: z.uuid().nullable(), foreground: z.boolean() }),
  ),
])
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>
