/** WebSocket outer structure and close codes (docs/05 section 4). Writes never go over WebSocket. */
import { z } from 'zod'

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

const envelope = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({
    v: z.literal(WS_PROTOCOL_VERSION),
    type: z.literal(type),
    topic: z.string().optional(),
    data,
  })

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

export const wsServerMessageSchema = z.discriminatedUnion('type', [
  wsHelloSchema,
  wsPongSchema,
  wsErrorSchema,
])
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>

/** Client messages carry no topic. Later milestones add typing, presence and focus. */
export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(WS_PROTOCOL_VERSION),
    type: z.literal('ping'),
    data: z.object({}).default({}),
  }),
])
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>
