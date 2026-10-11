/**
 * Browser push (docs/01 section 4.8, docs/03 section 7, SEC-23, D-065, M6).
 *
 * Three jobs live here:
 *  1. Subscriptions: a browser's endpoint is bound to the account, the sign-in (session) and the installation that made it.
 *     It goes with the session, and it never passes to another account without the installation's own proof.
 *  2. Deriving: when a message is written, one work item says "look at who this concerns". Deriving makes the in-site entries
 *     of the people it mentions or answers, and one push task per subscription of everybody the truth table pushes to.
 *  3. Delivering: right before a push leaves, everything is checked again (session, account, membership and boundary,
 *     whether the message still stands, preferences, whether the person is looking at that conversation, whether the
 *     subscription is still the one the task was made for). A task that no longer holds sends nothing; a push that does
 *     go carries no message text unless the person turned the preview on, and is built at that moment (D-065).
 *
 * A push handed to an external push service can be neither recalled nor counted exactly once (docs/03 section 7): a send
 * that timed out is tried again and may arrive twice.
 */
import { createHash } from 'node:crypto'
import {
  AppError,
  LIMITS,
  markdownPreviewText,
  type PushPayload,
  type PushSubscribeRequest,
  type PushSubscriptionInfo,
  plainMessageText,
  truncateCodePoints,
} from '@chatapp/contracts'
import {
  agentApprovals,
  agentRuns,
  attachments,
  authorizationOrigins,
  conversationMembers,
  conversations,
  type DbOrTx,
  messageMentions,
  messages,
  pushSubscriptions,
  sessions,
  users,
} from '@chatapp/db'
import { and, count, eq, gt, inArray, lt, or, sql } from 'drizzle-orm'
import type { PushMessage, PushOutcome } from '../runtime/push.ts'
import { EndpointError } from '../runtime/push-endpoints.ts'
import { validSubscriptionKeys } from '../runtime/web-push.ts'
import type { Deps } from './deps.ts'
import { createNotification } from './notifications.ts'
import {
  decideNotification,
  isMuted,
  type NotifyEvent,
  type NotifyPreferences,
  pushSettingsOf,
} from './notify-rules.ts'
import type { SessionPrincipal } from './principal.ts'
import { accountAllowsSession, lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'
import { enqueueWork } from './work.ts'

const MAX_USER_AGENT = 200
/** After this many pushes in a row that the push service refused for good, the subscription is dropped. */
const MAX_REFUSALS = 5

// ───────── subscriptions ─────────

type SubscriptionRow = typeof pushSubscriptions.$inferSelect

const infoOf = (row: SubscriptionRow, installationId: string | null): PushSubscriptionInfo => ({
  id: row.id,
  userAgent: row.userAgent,
  createdAt: row.createdAt.toISOString(),
  lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
  current: installationId !== null && row.installationId === installationId,
})

function requirePush(deps: Deps): NonNullable<Deps['push']> {
  if (!deps.push)
    throw new AppError('CAPACITY_UNAVAILABLE', 'Browser push is not set up on this server')
  return deps.push
}

/**
 * Registers the browser installation's endpoint (docs/05 section 3.7). The endpoint is checked as untrusted input, here and
 * again on every send: HTTPS, a known push service, public addresses only (SEC-23). Repeating the request is harmless.
 */
export async function subscribePush(
  deps: Deps,
  principal: SessionPrincipal,
  request: PushSubscribeRequest,
  userAgent: string | null,
): Promise<{ subscription: PushSubscriptionInfo; created: boolean }> {
  if (request.expectedUserId !== undefined && request.expectedUserId !== principal.userId) {
    throw new AppError('FORBIDDEN', 'This registration belongs to another account')
  }
  const push = requirePush(deps)
  const verdict = push.policy.check(request.endpoint)
  if (!verdict.ok) {
    throw new AppError('VALIDATION_FAILED', 'This push endpoint is not accepted', {
      details: { field: 'endpoint', reason: verdict.reason },
    })
  }
  try {
    await push.policy.resolve(verdict.hostname)
  } catch (error) {
    const reason = error instanceof EndpointError ? error.reason : 'dns_failed'
    throw new AppError('VALIDATION_FAILED', 'This push endpoint is not accepted', {
      details: { field: 'endpoint', reason },
    })
  }
  if (!validSubscriptionKeys(request.keys)) {
    throw new AppError('VALIDATION_FAILED', 'The subscription keys are not valid', {
      details: { field: 'keys' },
    })
  }
  const agent = userAgent ? userAgent.slice(0, MAX_USER_AGENT) : null

  return await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const [existing] = await tx
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.endpoint, request.endpoint))
      .for('update')

    if (existing) {
      const sameAccount = existing.userId === principal.userId
      // The endpoint is the browser's capability. Another account may take it over only with the installation's own secret
      // id: a browser that was signed in as somebody else and never unsubscribed. Anybody else is refused (D-065).
      if (!sameAccount && existing.installationId !== request.installationId) {
        throw new AppError('CONFLICT', 'This push endpoint belongs to another account', {
          details: { field: 'endpoint', reason: 'endpoint_in_use' },
        })
      }
      const rebound = !sameAccount || existing.sessionId !== principal.sessionId
      const [row] = await tx
        .update(pushSubscriptions)
        .set({
          userId: principal.userId,
          sessionId: principal.sessionId,
          installationId: request.installationId,
          p256dh: request.keys.p256dh,
          auth: request.keys.auth,
          userAgent: agent,
          failureCount: 0,
          ...(rebound ? { bindingVersion: sql`${pushSubscriptions.bindingVersion} + 1` } : {}),
        })
        .where(eq(pushSubscriptions.id, existing.id))
        .returning()
      if (!row) throw new Error('subscription vanished while rebinding')
      return { subscription: infoOf(row, request.installationId), created: false }
    }

    const [total] = await tx
      .select({ n: count() })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, principal.userId))
    if ((total?.n ?? 0) >= LIMITS.pushSubscriptionsPerUser) {
      throw new AppError('QUOTA_EXCEEDED', 'Too many browsers are subscribed; remove one first', {
        details: { limit: LIMITS.pushSubscriptionsPerUser },
      })
    }
    const [row] = await tx
      .insert(pushSubscriptions)
      .values({
        id: deps.newId(),
        userId: principal.userId,
        sessionId: principal.sessionId,
        endpoint: request.endpoint,
        installationId: request.installationId,
        p256dh: request.keys.p256dh,
        auth: request.keys.auth,
        userAgent: agent,
        createdAt: deps.clock.now(),
      })
      .returning()
    if (!row) throw new Error('subscription was not created')
    return { subscription: infoOf(row, request.installationId), created: true }
  })
}

export async function listPushSubscriptions(
  deps: Deps,
  principal: SessionPrincipal,
  installationId: string | null,
): Promise<PushSubscriptionInfo[]> {
  const rows = await deps.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, principal.userId))
    .orderBy(pushSubscriptions.createdAt)
  return rows.map((row) => infoOf(row, installationId))
}

/** Removes one of the caller's subscriptions. Somebody else's, or none at all, is the same "not found". */
export async function unsubscribePush(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<void> {
  const removed = await deps.db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, principal.userId)))
    .returning({ id: pushSubscriptions.id })
  if (removed.length === 0) throw new AppError('NOT_FOUND', 'Subscription not found')
}

/** Sends a test push to the caller's own subscription of this installation (to see that it works on this device). */
export async function queueTestPush(
  deps: Deps,
  principal: SessionPrincipal,
  installationId: string,
): Promise<{ queued: boolean }> {
  requirePush(deps)
  return await inTransaction(deps.db, async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const [row] = await tx
      .select()
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, principal.userId),
          eq(pushSubscriptions.installationId, installationId),
          eq(pushSubscriptions.sessionId, principal.sessionId),
        ),
      )
    if (!row) return { queued: false }
    await enqueueWork(tx, deps, {
      kind: 'push',
      dedupeKey: `push:test:${deps.newId()}`,
      entityId: principal.userId,
      payload: {
        stage: 'deliver',
        event: 'test',
        subscriptionId: row.id,
        bindingVersion: row.bindingVersion,
        userId: principal.userId,
      },
    })
    return { queued: true }
  })
}

// ───────── preferences of one person for one conversation ─────────

/** The settings and the level/mute of the conversation, as the truth table needs them (docs/01 section 4.8). */
export async function loadPreferences(
  db: DbOrTx,
  userId: string,
  conversationId: string | null,
  now: Date,
): Promise<NotifyPreferences | null> {
  const [user] = await db
    .select({ settings: users.settings })
    .from(users)
    .where(eq(users.id, userId))
  if (!user) return null
  const [member] = conversationId
    ? await db
        .select({
          level: conversationMembers.notifyLevel,
          muteMode: conversationMembers.muteMode,
          mutedUntil: conversationMembers.mutedUntil,
        })
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, userId),
          ),
        )
    : []
  const settings = pushSettingsOf(user.settings)
  return {
    pushEnabled: settings.pushEnabled,
    assistantEnabled: settings.assistantEnabled,
    // No membership (a conversation that is gone) leaves only the account switches to decide.
    level: member?.level ?? 'all',
    muted: member ? isMuted(member, now) : false,
  }
}

const DELIVER_EVENTS = ['plain', 'mention', 'reply', 'approval', 'reminder', 'test'] as const
type DeliverEvent = (typeof DELIVER_EVENTS)[number]

/**
 * One push task per subscription of the person, when the truth table says this event pushes (docs/01 section 4.8). The
 * tasks only name the subscription, the binding it was made for and what happened; everything is checked again when they run.
 */
export async function enqueuePushes(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  input: {
    userId: string
    event: NotifyEvent
    prefs: NotifyPreferences
    /** The message, or the approval, the push is about; also the dedupe key's anchor. */
    entityId: string
  },
): Promise<number> {
  if (!decideNotification(input.event, input.prefs).push) return 0
  const subs = await tx
    .select({ id: pushSubscriptions.id, bindingVersion: pushSubscriptions.bindingVersion })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, input.userId))
  for (const sub of subs) {
    await enqueueWork(tx, deps, {
      kind: 'push',
      dedupeKey: `push:${input.event}:${input.entityId}:${sub.id}:${sub.bindingVersion}`,
      entityId: input.entityId,
      payload: {
        stage: 'deliver',
        event: input.event,
        subscriptionId: sub.id,
        bindingVersion: sub.bindingVersion,
        userId: input.userId,
      },
    })
  }
  return subs.length
}

// ───────── events about the assistant ─────────

/**
 * A person is waiting for the assistant to be allowed to act: an entry in the centre, and a push when the truth table says
 * so. Runs inside the transaction that registers the approval.
 */
export async function notifyApprovalRequested(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock' | 'newId'>,
  input: { userId: string; approvalId: string; runId: string; conversationId: string | null },
): Promise<void> {
  await createNotification(tx, deps, {
    userId: input.userId,
    type: 'approval_requested',
    dedupeKey: `approval:${input.approvalId}`,
    data: {
      approvalId: input.approvalId,
      runId: input.runId,
      conversationId: input.conversationId,
    },
  })
  const prefs = await loadPreferences(tx, input.userId, input.conversationId, deps.clock.now())
  if (prefs) {
    await enqueuePushes(tx, deps, {
      userId: input.userId,
      event: 'approval',
      prefs,
      entityId: input.approvalId,
    })
  }
}

/** A reminder came due and was delivered as a message in the person's reminders conversation. */
export async function notifyReminderDue(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock' | 'newId'>,
  input: { userId: string; reminderId: string; conversationId: string; messageId: string },
): Promise<void> {
  await createNotification(tx, deps, {
    userId: input.userId,
    type: 'reminder',
    dedupeKey: `reminder:${input.reminderId}`,
    data: {
      reminderId: input.reminderId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    },
  })
  const prefs = await loadPreferences(tx, input.userId, input.conversationId, deps.clock.now())
  if (prefs) {
    await enqueuePushes(tx, deps, {
      userId: input.userId,
      event: 'reminder',
      prefs,
      entityId: input.messageId,
    })
  }
}

// ───────── deriving from a message ─────────

/** Whom a message may name before it is no longer a short list: the snapshot has to fit a work payload. */
const MAX_NAMED = 40

/**
 * A message of a person was written: remember to look at who it concerns (in the message's own transaction). The people it
 * names at this moment go with the task, because an edit is not a new message: somebody added by an edit before the task
 * runs must not be notified (docs/01 section 4.5).
 */
export async function enqueueMessageNotifications(
  tx: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  messageId: string,
  named: readonly string[],
): Promise<void> {
  await enqueueWork(tx, deps, {
    kind: 'push',
    dedupeKey: `notify:${messageId}`,
    entityId: messageId,
    payload: { stage: 'message', named: [...new Set(named)].slice(0, MAX_NAMED).join(',') },
  })
}

export type DeriveOutcome = 'done' | 'skipped'

/**
 * Turns one written message into entries and push tasks. Idempotent: the entry has a dedupe key per person and message, the
 * push tasks one per message and subscription, so running it again after a crash adds nothing. Every recipient is handled
 * in a transaction of its own (it takes only that person's lock).
 */
export async function deriveMessageNotifications(
  deps: Deps,
  messageId: string,
  /** The people the message named when it was written (from the task), or null when unknown. */
  named: readonly string[] | null = null,
): Promise<DeriveOutcome> {
  const [message] = await deps.db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      seq: messages.seq,
      kind: messages.kind,
      senderId: messages.senderId,
      replyToId: messages.replyToId,
      recalledAt: messages.recalledAt,
      deletedAt: messages.deletedAt,
      conversationKind: conversations.kind,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, messageId))
  // The assistant's own conversations have nobody else to tell; system lines and the assistant's output never notify.
  if (
    message?.kind !== 'user' ||
    message.senderId === null ||
    message.recalledAt ||
    message.deletedAt ||
    message.conversationKind === 'agent'
  ) {
    return 'skipped'
  }
  const senderId = message.senderId

  // Named when it was written *and* still named: an edit that added somebody does not notify them, one that removed
  // somebody does not notify them either.
  const mentioned = (
    await deps.db
      .select({ userId: messageMentions.userId })
      .from(messageMentions)
      .where(eq(messageMentions.messageId, messageId))
  )
    .map((row) => row.userId)
    .filter((userId) => named === null || named.includes(userId))
  const [replied] = message.replyToId
    ? await deps.db
        .select({ senderId: messages.senderId })
        .from(messages)
        .where(
          and(
            eq(messages.id, message.replyToId),
            eq(messages.conversationId, message.conversationId),
          ),
        )
    : []
  const repliedTo = replied?.senderId ?? null

  const now = deps.clock.now()
  // Members who are named, answered, or have a browser subscribed; everybody else cannot be told anything.
  const recipients = await deps.db
    .select({
      userId: conversationMembers.userId,
      level: conversationMembers.notifyLevel,
      muteMode: conversationMembers.muteMode,
      mutedUntil: conversationMembers.mutedUntil,
      settings: users.settings,
    })
    .from(conversationMembers)
    .innerJoin(users, eq(users.id, conversationMembers.userId))
    .where(
      and(
        eq(conversationMembers.conversationId, message.conversationId),
        sql`${conversationMembers.userId} <> ${senderId}`,
        lt(conversationMembers.visibleFromSeq, message.seq),
        eq(users.isBot, false),
        sql`${users.deletedAt} is null`,
        or(
          mentioned.length ? inArray(conversationMembers.userId, mentioned) : undefined,
          repliedTo ? eq(conversationMembers.userId, repliedTo) : undefined,
          sql`exists (select 1 from ${pushSubscriptions} s where s.user_id = ${conversationMembers.userId})`,
        ),
      ),
    )

  for (const recipient of recipients) {
    const event: NotifyEvent = mentioned.includes(recipient.userId)
      ? 'mention'
      : repliedTo === recipient.userId
        ? 'reply'
        : 'plain'
    const settings = pushSettingsOf(recipient.settings)
    const prefs: NotifyPreferences = {
      pushEnabled: settings.pushEnabled,
      assistantEnabled: settings.assistantEnabled,
      level: recipient.level,
      muted: isMuted(recipient, now),
    }
    const decision = decideNotification(event, prefs)
    if (!decision.site && !decision.push) continue
    await inTransaction(deps.db, async (tx) => {
      if (decision.site && (event === 'mention' || event === 'reply')) {
        await createNotification(tx, deps, {
          userId: recipient.userId,
          type: event,
          dedupeKey: `msg:${messageId}`,
          data: {
            conversationId: message.conversationId,
            messageId,
            senderId,
          },
        })
      }
      await enqueuePushes(tx, deps, { userId: recipient.userId, event, prefs, entityId: messageId })
    })
  }
  return 'done'
}

// ───────── delivering ─────────

export type PushPorts = {
  /** Whether the person has a live, active page in front on this conversation right now (best effort, docs/01 section 4.8). */
  viewing(userId: string, conversationId: string): Promise<boolean>
}

export type DeliverResult =
  | { kind: 'done'; outcome: string }
  /** The push could not be handed over; the task is tried again later. */
  | { kind: 'retry'; reason: string }

const TEXT = {
  zh: {
    fresh: '你有新消息',
    approval: '助手在等待你的批准',
    reminder: '提醒',
    test: '这是一条测试通知：这台设备可以收到推送。',
  },
  en: {
    fresh: 'You have a new message',
    approval: 'The assistant is waiting for your approval',
    reminder: 'Reminder',
    test: 'This is a test notification: push works on this device.',
  },
} as const
const textFor = (locale: string) => (locale.toLowerCase().startsWith('zh') ? TEXT.zh : TEXT.en)

const topicOf = (userId: string, tag: string): string =>
  createHash('sha256').update(`${userId}:${tag}`).digest('base64url').slice(0, 32)

/**
 * Everything unread in the conversations the sidebar lists that are neither muted nor switched off: what the app badge and
 * the title show (docs/01 section 4.8). The client counts the same set (`lib/unread.ts`), so a closed window's badge agrees
 * with an open one.
 */
export async function unreadForBadge(db: DbOrTx, userId: string, now: Date): Promise<number> {
  const [row] = await db
    .select({
      n: sql<number>`coalesce(sum(greatest(${conversations.lastSeq} - ${conversationMembers.lastReadSeq}, 0)), 0)::int`,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.userId, userId),
        sql`${conversationMembers.hiddenAt} is null`,
        sql`${conversations.archivedAt} is null`,
        sql`${conversations.panelForConversationId} is null`,
        sql`${conversationMembers.notifyLevel} <> 'none'`,
        or(
          eq(conversationMembers.muteMode, 'off'),
          and(eq(conversationMembers.muteMode, 'until'), lt(conversationMembers.mutedUntil, now)),
        ),
      ),
    )
  return Math.min(row?.n ?? 0, 999)
}

type Target = {
  conversationId: string | null
  /** Check that the thing the push is about still stands; false drops the push quietly. */
  standing: boolean
  built: Omit<PushPayload, 'userId' | 'unread' | 'title'> & { title: string | null }
}

/**
 * Sends the push one task stands for, after checking everything again (the module comment lists what). Returns `done` for
 * every case that sends nothing or has sent it, `retry` when the push service could not take it now.
 */
export async function deliverPush(
  deps: Deps,
  work: { entityId: string | null; payload: Record<string, unknown> },
  ports: PushPorts,
): Promise<DeliverResult> {
  const push = deps.push
  if (!push) return { kind: 'done', outcome: 'push_unavailable' }
  const subscriptionId =
    typeof work.payload.subscriptionId === 'string' ? work.payload.subscriptionId : null
  const userId = typeof work.payload.userId === 'string' ? work.payload.userId : null
  const bindingVersion =
    typeof work.payload.bindingVersion === 'number' ? work.payload.bindingVersion : null
  const event = DELIVER_EVENTS.find((candidate) => candidate === work.payload.event)
  if (!subscriptionId || !userId || bindingVersion === null || !event) {
    return { kind: 'done', outcome: 'malformed' }
  }
  const now = deps.clock.now()

  // The subscription must still be the one the task was made for: same account, same binding (D-065).
  const [sub] = await deps.db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.id, subscriptionId))
  if (!sub || sub.userId !== userId || sub.bindingVersion !== bindingVersion) {
    return { kind: 'done', outcome: 'binding_changed' }
  }
  // Every cleanup/outcome below still belongs to this captured binding. DNS, permission reads and sending can yield while
  // the same installation is handed to a new session; an old answer must never update or remove that new subscription.
  const capturedBinding = and(
    eq(pushSubscriptions.id, sub.id),
    eq(pushSubscriptions.userId, sub.userId),
    eq(pushSubscriptions.sessionId, sub.sessionId),
    eq(pushSubscriptions.bindingVersion, sub.bindingVersion),
  )
  // The sign-in it was made under must be alive, and the account must still be allowed to hold one.
  const [login] = await deps.db
    .select({
      expiresAt: sessions.expiresAt,
      sessionEpoch: sessions.authEpoch,
      revokedAt: authorizationOrigins.revokedAt,
      endedAt: authorizationOrigins.endedAt,
      restoreEpoch: authorizationOrigins.restoreEpoch,
      user: users,
    })
    .from(sessions)
    .innerJoin(authorizationOrigins, eq(authorizationOrigins.id, sessions.authorizationOriginId))
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sub.sessionId))
  if (
    !login ||
    login.expiresAt <= now ||
    login.revokedAt !== null ||
    login.endedAt !== null ||
    login.restoreEpoch !== deps.config.auth.restoreEpoch ||
    login.sessionEpoch !== login.user.authEpoch ||
    login.user.id !== userId ||
    !accountAllowsSession(login.user, now)
  ) {
    await deps.db.delete(pushSubscriptions).where(capturedBinding)
    return { kind: 'done', outcome: 'session_ended' }
  }

  const text = textFor(login.user.locale)
  const settings = pushSettingsOf(login.user.settings)
  const target = await describeTarget(
    deps,
    login.user,
    event,
    work.entityId,
    text,
    settings.preview,
    now,
  )
  if (target === null || !target.standing) return { kind: 'done', outcome: 'no_longer_valid' }

  if (event !== 'test') {
    const prefs = await loadPreferences(deps.db, userId, target.conversationId, now)
    if (!prefs || !decideNotification(event, prefs).push)
      return { kind: 'done', outcome: 'suppressed' }
    if (target.conversationId && (await ports.viewing(userId, target.conversationId))) {
      return { kind: 'done', outcome: 'viewing' }
    }
  }

  const payload: PushPayload = {
    ...target.built,
    title: target.built.title ?? deps.config.product.name,
    userId,
    unread: await unreadForBadge(deps.db, userId, now),
  }
  const message: PushMessage = {
    payload,
    urgency: event === 'plain' ? 'normal' : 'high',
    topic: topicOf(userId, payload.tag),
  }
  const outcome: PushOutcome = await push.sender.send(
    { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
    message,
  )
  switch (outcome.kind) {
    case 'delivered':
      await deps.db
        .update(pushSubscriptions)
        .set({ lastSuccessAt: now, failureCount: 0 })
        .where(capturedBinding)
      return { kind: 'done', outcome: 'delivered' }
    case 'gone':
      await deps.db.delete(pushSubscriptions).where(capturedBinding)
      return { kind: 'done', outcome: `gone:${outcome.reason}` }
    case 'rejected': {
      const failures = sub.failureCount + 1
      if (failures >= MAX_REFUSALS) {
        await deps.db.delete(pushSubscriptions).where(capturedBinding)
      } else {
        await deps.db
          .update(pushSubscriptions)
          .set({ failureCount: failures })
          .where(capturedBinding)
      }
      return { kind: 'done', outcome: `rejected:${outcome.reason}` }
    }
    case 'retry':
      return { kind: 'retry', reason: outcome.reason }
  }
}

/** What the push is about, as it stands now: its text, its click target and whether it still holds. */
async function describeTarget(
  deps: Deps,
  user: typeof users.$inferSelect,
  event: DeliverEvent,
  entityId: string | null,
  text: (typeof TEXT)['zh'] | (typeof TEXT)['en'],
  preview: boolean,
  now: Date,
): Promise<Target | null> {
  const generic = (url: string, tag: string, kind: PushPayload['kind']): Target['built'] => ({
    v: 1,
    kind,
    title: null,
    body: text.fresh,
    url,
    tag,
  })
  if (event === 'test') {
    return {
      conversationId: null,
      standing: true,
      built: { ...generic('/', 'test', 'test'), body: text.test },
    }
  }
  if (entityId === null) return null

  if (event === 'approval') {
    const [row] = await deps.db
      .select({
        status: agentApprovals.status,
        expiresAt: agentApprovals.expiresAt,
        userId: agentApprovals.userId,
        conversationId: agentRuns.conversationId,
      })
      .from(agentApprovals)
      .innerJoin(agentRuns, eq(agentRuns.id, agentApprovals.runId))
      .where(eq(agentApprovals.id, entityId))
    if (!row || row.userId !== user.id) return null
    const url = row.conversationId ? `/c/${row.conversationId}` : '/'
    return {
      conversationId: row.conversationId,
      standing: row.status === 'pending' && row.expiresAt > now,
      built: {
        ...generic(url, `a-${entityId}`, 'approval'),
        ...(preview ? { body: text.approval } : {}),
      },
    }
  }

  // The rest are about a message: a person's message (plain, mention, reply) or a reminder the assistant delivered.
  const [message] = await deps.db
    .select({
      id: messages.id,
      conversationId: messages.conversationId,
      seq: messages.seq,
      kind: messages.kind,
      senderId: messages.senderId,
      body: messages.body,
      recalledAt: messages.recalledAt,
      deletedAt: messages.deletedAt,
      conversationKind: conversations.kind,
      conversationName: conversations.name,
      attachmentKind: sql<
        'image' | 'video' | 'audio' | 'file' | null
      >`(select a.kind from ${attachments} a where a.message_id = "messages"."id" and a.status = 'ready' and a.privacy_class = 'standard' order by a.position limit 1)`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, entityId))
  if (!message) return null
  const [member] = await deps.db
    .select({ visibleFromSeq: conversationMembers.visibleFromSeq })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, message.conversationId),
        eq(conversationMembers.userId, user.id),
      ),
    )
  // Still a member, still after the boundary, and the message not withdrawn: a push for what the person can no longer
  // see would be a leak (AT-11).
  const standing =
    member !== undefined &&
    message.seq > member.visibleFromSeq &&
    message.recalledAt === null &&
    message.deletedAt === null &&
    (event === 'reminder' ? message.kind === 'agent' : message.kind === 'user')
  const url = `/c/${message.conversationId}`
  const kind: PushPayload['kind'] =
    event === 'plain' ? 'message' : (event as 'mention' | 'reply' | 'reminder')
  const built = generic(url, `c-${message.conversationId}`, kind)
  if (preview && standing) {
    const sender = message.senderId
      ? (
          await deps.db
            .select({ name: users.name })
            .from(users)
            .where(eq(users.id, message.senderId))
        )[0]
      : undefined
    const excerpt = truncateCodePoints(
      plainMessageText(markdownPreviewText(message.body), () => undefined, message.attachmentKind),
      LIMITS.pushPreviewMaxCodePoints,
    )
    if (event === 'reminder') {
      built.title = text.reminder
      built.body = excerpt || text.fresh
    } else if (message.conversationKind === 'dm') {
      built.title = sender?.name ?? null
      built.body = excerpt || text.fresh
    } else {
      built.title = message.conversationName
      built.body = excerpt ? `${sender?.name ?? ''}: ${excerpt}`.replace(/^: /, '') : text.fresh
    }
  }
  return { conversationId: message.conversationId, standing, built }
}

// ───────── retention ─────────

/** Subscriptions whose last 5 sends were refused or that never succeeded for a month are dropped by the cleanup job. */
export async function pruneStaleSubscriptions(deps: Deps): Promise<number> {
  const cutoff = new Date(deps.clock.now().getTime() - 30 * 86_400_000)
  const removed = await deps.db
    .delete(pushSubscriptions)
    .where(
      and(
        gt(pushSubscriptions.failureCount, 0),
        lt(
          sql`coalesce(${pushSubscriptions.lastSuccessAt}, ${pushSubscriptions.createdAt})`,
          cutoff,
        ),
      ),
    )
    .returning({ id: pushSubscriptions.id })
  return removed.length
}
