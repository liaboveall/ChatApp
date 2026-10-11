/**
 * In-site notifications and browser push (docs/01 section 4.8, docs/04 section 6, docs/05 section 3.7, M6).
 *
 * A notification row stores identifiers only. Everything shown here is projected when it is read, with the reader's current
 * access: a conversation they left, a message that was withdrawn or a run that is gone turns the entry into
 * `{ available: false }` and never returns what was there before (docs/04 section 6).
 */
import { z } from 'zod'
import { conversationKindSchema } from './enums.ts'
import { LIMITS } from './limits.ts'
import { userSummarySchema } from './users.ts'

const count = z.number().int().min(0)

export const notificationConversationSchema = z.object({
  id: z.uuid(),
  kind: conversationKindSchema,
  /** null for a direct message: the screen names the other person. */
  name: z.string().nullable(),
})
export type NotificationConversation = z.infer<typeof notificationConversationSchema>

/** What is left of a source the reader may no longer see: a generic entry, nothing from before (docs/04 section 6). */
const unavailable = z.object({ available: z.literal(false) })

const messageRef = z.object({
  id: z.uuid(),
  seq: count,
  /** Plain text of the message as it is now; null once it was withdrawn or deleted, or when it is only an attachment. */
  preview: z.string().nullable(),
  /** Set when the message carries a file, so the screen can word the placeholder in the reader's language. */
  attachmentKind: z.enum(['image', 'video', 'audio', 'file']).optional(),
  recalled: z.boolean(),
})

const messageSource = z.object({
  available: z.literal(true),
  conversation: notificationConversationSchema,
  message: messageRef,
  sender: userSummarySchema,
})

const approvalSource = z.object({
  available: z.literal(true),
  approval: z.object({
    id: z.uuid(),
    runId: z.uuid(),
    status: z.enum(['pending', 'approved', 'rejected', 'expired']),
    expiresAt: z.iso.datetime(),
  }),
  /** Where the run writes its output, so the entry opens the conversation the approval card is in. */
  conversationId: z.uuid().nullable(),
})

/** A reminder arrives as a message of the assistant in the person's "reminders" conversation. */
const reminderSource = z.object({
  available: z.literal(true),
  conversation: notificationConversationSchema,
  message: messageRef,
})

/** Site administrators only (D-034): the site budget crossed a threshold. Amounts are the site's own, never a person's. */
const budgetAlertData = z.object({
  period: z.string(),
  percent: z.union([z.literal(80), z.literal(100)]),
})

const reportSource = z.object({ available: z.literal(true), reportId: z.uuid() })

const base = {
  id: z.uuid(),
  version: z.number().int().min(1),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
}

export const notificationSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('mention'), data: z.union([messageSource, unavailable]) }),
  z.object({ ...base, type: z.literal('reply'), data: z.union([messageSource, unavailable]) }),
  z.object({
    ...base,
    type: z.literal('approval_requested'),
    data: z.union([approvalSource, unavailable]),
  }),
  z.object({ ...base, type: z.literal('reminder'), data: z.union([reminderSource, unavailable]) }),
  z.object({ ...base, type: z.literal('budget_alert'), data: budgetAlertData }),
  z.object({
    ...base,
    type: z.literal('report_opened'),
    data: z.union([reportSource, unavailable]),
  }),
])
export type Notification = z.infer<typeof notificationSchema>

export const notificationsQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.notificationsPageMax).optional(),
})
export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>

export const notificationPageSchema = z.object({
  items: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  /** All unread entries of the person, not only those on this page. */
  unreadCount: count,
})
export type NotificationPage = z.infer<typeof notificationPageSchema>

/** `{ ids }` marks those entries; `{ all: true }` marks everything that is unread. */
export const markNotificationsReadSchema = z.union([
  z.strictObject({
    ids: z.array(z.uuid()).min(1).max(LIMITS.notificationsReadMax),
  }),
  z.strictObject({ all: z.literal(true) }),
])
export type MarkNotificationsRead = z.infer<typeof markNotificationsReadSchema>

export const markNotificationsReadResponseSchema = z.object({
  /** The entries that changed, with their new versions (empty after `all`: the client reads the list again). */
  items: z.array(notificationSchema),
  unreadCount: count,
})
export type MarkNotificationsReadResponse = z.infer<typeof markNotificationsReadResponseSchema>

// ───────── Browser push ─────────

const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/, 'Expected base64url')

/** `PushSubscription.toJSON()` of the browser plus the installation that holds it (docs/05 section 3.7). */
export const pushSubscribeRequestSchema = z.strictObject({
  endpoint: z.string().min(1).max(LIMITS.pushEndpointMaxLength),
  keys: z.strictObject({
    /** The browser's uncompressed P-256 public key: 65 bytes. */
    p256dh: base64url(86, 88),
    /** The 16-byte authentication secret. */
    auth: base64url(22, 24),
  }),
  /** A random id the browser made for itself; it proves that a re-subscription comes from the same installation. */
  installationId: z.uuid(),
  /** The account that began an asynchronous registration; a cookie belonging to another account must not take it over. */
  expectedUserId: z.uuid().optional(),
})
export type PushSubscribeRequest = z.infer<typeof pushSubscribeRequestSchema>

export const pushSubscriptionSchema = z.object({
  id: z.uuid(),
  /** The browser's `User-Agent` as it subscribed (cut short); the screen names the device from it, like the device list. */
  userAgent: z.string().nullable(),
  createdAt: z.iso.datetime(),
  lastSuccessAt: z.iso.datetime().nullable(),
  /** True for the subscription of the installation that asked. */
  current: z.boolean(),
})
export type PushSubscriptionInfo = z.infer<typeof pushSubscriptionSchema>

export const pushSubscriptionResponseSchema = z.object({ subscription: pushSubscriptionSchema })
export const pushSubscriptionListSchema = z.object({
  subscriptions: z.array(pushSubscriptionSchema),
})
export const pushSubscriptionsQuerySchema = z.object({ installationId: z.uuid().optional() })

/** The application server key the browser subscribes with; public by design. */
export const vapidKeyResponseSchema = z.object({ publicKey: base64url(80, 100) })

export const pushTestResponseSchema = z.object({ queued: z.boolean() })

/** The fields of the encrypted payload the service worker reads. It carries no message text unless the person opted in. */
export const pushPayloadSchema = z.object({
  v: z.literal(1),
  /** The account the push was made for; the service worker shows nothing to anybody else (docs/01 section 4.8). */
  userId: z.uuid(),
  kind: z.enum(['message', 'mention', 'reply', 'approval', 'reminder', 'test']),
  title: z.string().max(120),
  body: z.string().max(240),
  /** Same-origin path opened by a click; always one of the app's own routes. */
  url: z
    .string()
    .max(200)
    .regex(/^\/[A-Za-z0-9/_-]*$/),
  /** Pushes with the same tag replace each other (one per conversation). */
  tag: z.string().max(80),
  /** Everything unread, for the app badge while no window is open. */
  unread: count,
})
export type PushPayload = z.infer<typeof pushPayloadSchema>
