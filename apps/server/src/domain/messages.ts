/**
 * Messages (docs/05 section 3.4, docs/03 sections 5.1 and 5.3, docs/01 section 4.5): sending in one transaction with the
 * sequence numbers, the sync log and the realtime hint; reading as the viewer sees it; edit, recall, delete-for-me and
 * administrator delete. A message is always projected for one reader: nothing from before they joined, nothing they hid,
 * and a reply quote that reveals nothing they may not see (INV-09, INV-12).
 */
import {
  AppError,
  type DeletionIntent,
  type DeletionOperation,
  type EditMessageRequest,
  type ExecutionSource,
  LIMITS,
  type Message,
  type MessageEnvelope,
  type MessageMeta,
  type MessagesQuery,
  type MessagesResponse,
  markdownPreviewText,
  mentionIds,
  plainMessageText,
  type ReplayMessageRequest,
  type ReplyTo,
  type SendMessageRequest,
  type SystemEvent,
  truncateCodePoints,
  type UserRole,
  type UsersDictionary,
} from '@chatapp/contracts'
import {
  agentContexts,
  attachments,
  conversationMembers,
  conversations,
  type DbOrTx,
  messageHidden,
  messageMentions,
  messages,
  reports,
  type Tx,
  users,
} from '@chatapp/db'
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  lt,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import { fingerprint } from '../lib/crypto.ts'
import { enqueueRunForSource } from './agent-runs.ts'
import { attachmentDto, firstAttachmentKind, lockStorage } from './attachment-common.ts'
import { writeAudit } from './audit.ts'
import { type ConversationRow, enforce, loadAccess, type MemberRow } from './authorize.ts'
import {
  allocateChangeSeq,
  allocateMessageSeq,
  recordMessageChange,
  recordUserChange,
  recordViewerChange,
} from './changes.ts'
import { applyDeletion } from './deletion-apply.ts'
import {
  assertDeletionMutable,
  findDeletion,
  prepareDeletion,
  settleDeletion,
} from './deletion-operations.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { enqueueMessageNotifications } from './push.ts'
import { lockAndRevalidate } from './sessions.ts'
import { readSiteLimits } from './site-policy.ts'
import { inTransaction } from './tx.ts'
import { retireAttachment } from './uploads.ts'
import { usersDictionary } from './users.ts'

export type MessageRow = typeof messages.$inferSelect

/** Whose eyes: the person and the boundary below which nothing is theirs to see (`visible_from_seq`). */
export type Viewer = { userId: string; visibleFromSeq: number }

/** Newlines are `\n` and trailing blank space goes: the stored body is what every reader sees (docs/01 section 4.5). */
export function normalizeBody(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/\s+$/u, '')
}

const hiddenFromViewer = (db: DbOrTx, viewerId: string) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(messageHidden)
      .where(and(eq(messageHidden.userId, viewerId), eq(messageHidden.messageId, messages.id))),
  )

/** The viewer's own "deleted for me" mark, as a column beside the message it is read with. */
export const hiddenMark = (db: DbOrTx, viewerId: string) =>
  sql<boolean>`${exists(
    db
      .select({ one: sql`1` })
      .from(messageHidden)
      .where(and(eq(messageHidden.userId, viewerId), eq(messageHidden.messageId, messages.id))),
  )}`

/** The messages of a conversation this viewer may see: after their boundary, and not deleted for them. */
export function visibleTo(db: DbOrTx, viewer: Viewer, conversationId: string) {
  return and(
    eq(messages.conversationId, conversationId),
    gt(messages.seq, viewer.visibleFromSeq),
    hiddenFromViewer(db, viewer.userId),
  )
}

// ───────── projection ─────────

function systemUserIds(event: SystemEvent | undefined): string[] {
  if (!event) return []
  switch (event.type) {
    case 'member_joined':
      return [event.userId, ...(event.addedBy ? [event.addedBy] : [])]
    case 'member_left':
      return [event.userId]
    case 'member_removed':
      return [event.userId, event.actorId]
    case 'conversation_renamed':
      return [event.actorId]
    case 'owner_transferred':
      return [event.actorId, event.userId]
  }
}

/**
 * Turns stored rows into what `viewer` may be shown, plus the dictionary of people they mention. Reply targets are
 * judged with the viewer's own boundary and hidden marks; one that is not theirs to see becomes a bare
 * `unavailable` with no id, sequence number, sender or excerpt.
 *
 * The rows themselves are held to the boundary too, whoever fetched them: a row from before it is left out, so a caller
 * that looked a message up by some other key (a retried `clientId`, say) cannot hand the viewer what predates them
 * (INV-09). A caller that needs one particular row treats its absence from the result as "not found".
 */
export async function projectMessages(
  db: DbOrTx,
  viewer: Viewer,
  fetched: readonly MessageRow[],
): Promise<{ messages: Message[]; users: UsersDictionary }> {
  const rows = fetched.filter((row) => row.seq > viewer.visibleFromSeq)
  const replyIds = [
    ...new Set(rows.map((row) => row.replyToId).filter((id): id is string => id !== null)),
  ]
  const targets = new Map<
    string,
    {
      id: string
      conversationId: string
      seq: number
      senderId: string | null
      kind: MessageRow['kind']
      excerpt: string | null
      attachmentKind: Message['attachments'][number]['kind'] | null
      recalledAt: Date | null
      deletedAt: Date | null
    }
  >()
  const hidden = new Set<string>()
  if (replyIds.length > 0) {
    const found = await db
      .select({
        id: messages.id,
        conversationId: messages.conversationId,
        seq: messages.seq,
        senderId: messages.senderId,
        kind: messages.kind,
        excerpt: messages.body,
        attachmentKind: firstAttachmentKind,
        recalledAt: messages.recalledAt,
        deletedAt: messages.deletedAt,
        hidden: hiddenMark(db, viewer.userId),
      })
      .from(messages)
      .where(inArray(messages.id, replyIds))
    for (const { hidden: mark, ...row } of found) {
      targets.set(row.id, row)
      if (mark) hidden.add(row.id)
    }
  }

  // Resolve only visible, live reply targets; hidden history cannot add people to the response.
  const replyPeople = new Set<string>()
  for (const target of targets.values()) {
    if (
      rows.some(
        (row) => row.replyToId === target.id && row.conversationId === target.conversationId,
      ) &&
      target.seq > viewer.visibleFromSeq &&
      !hidden.has(target.id) &&
      !target.recalledAt &&
      !target.deletedAt
    )
      for (const id of mentionIds(target.excerpt ?? '')) replyPeople.add(id)
  }
  const replyUsers = await usersDictionary(db, replyPeople)
  const replyOf = (row: MessageRow): ReplyTo | null => {
    if (row.replyToId === null) return null
    const target = targets.get(row.replyToId)
    if (
      !target ||
      target.conversationId !== row.conversationId ||
      target.seq <= viewer.visibleFromSeq ||
      hidden.has(target.id)
    ) {
      return { state: 'unavailable' }
    }
    const state = target.deletedAt ? 'deleted' : target.recalledAt ? 'recalled' : 'ok'
    return {
      id: target.id,
      seq: target.seq,
      senderId: target.senderId,
      excerpt:
        state === 'ok' && (target.excerpt !== null || target.attachmentKind !== null)
          ? truncateCodePoints(
              plainMessageText(
                markdownPreviewText(target.excerpt),
                (id) => replyUsers[id]?.displayName,
                target.attachmentKind,
              ),
              LIMITS.excerptMaxCodePoints,
            )
          : null,
      ...(state === 'ok' && target.attachmentKind ? { attachmentKind: target.attachmentKind } : {}),
      state,
    }
  }

  const rowIds = rows.filter((row) => !row.recalledAt && !row.deletedAt).map((row) => row.id)
  // One after the other: outside a transaction two statements at once would take two pooled connections for one
  // request (docs/03 section 10).
  const files = rowIds.length
    ? await db
        .select()
        .from(attachments)
        .where(
          and(
            inArray(attachments.messageId, rowIds),
            eq(attachments.status, 'ready'),
            eq(attachments.purpose, 'message'),
            eq(attachments.privacyClass, 'standard'),
          ),
        )
        .orderBy(asc(attachments.position))
    : []
  const mentioned = rowIds.length
    ? await db.select().from(messageMentions).where(inArray(messageMentions.messageId, rowIds))
    : []
  const projected: Message[] = rows.map((row) => {
    const gone = row.recalledAt !== null || row.deletedAt !== null
    return {
      contextEpoch: row.contextEpoch,
      id: row.id,
      conversationId: row.conversationId,
      seq: row.seq,
      changeSeq: row.changeSeq,
      kind: row.kind,
      status: row.status,
      senderId: row.senderId,
      body: gone ? null : row.body,
      replyTo: replyOf(row),
      attachments: gone ? [] : files.filter((file) => file.messageId === row.id).map(attachmentDto),
      mentions: gone
        ? []
        : mentioned
            .filter((mention) => mention.messageId === row.id)
            .map((mention) => mention.userId),
      streamRevision: row.streamRevision,
      editedAt: row.editedAt?.toISOString() ?? null,
      recalledAt: row.recalledAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      meta: row.meta,
    }
  })

  const people = new Set<string | null>(mentioned.map((mention) => mention.userId))
  for (const row of rows) {
    people.add(row.senderId)
    for (const id of systemUserIds(row.meta.system)) people.add(id)
    const reply = row.replyToId ? replyOf(row) : null
    if (reply && 'senderId' in reply) people.add(reply.senderId)
  }
  return { messages: projected, users: await usersDictionary(db, people) }
}

// ───────── reading ─────────

async function memberOf(
  db: DbOrTx,
  deps: Pick<Deps, 'clock'>,
  principal: SessionPrincipal,
  conversationId: string,
): Promise<MemberRow> {
  const access = await loadAccess(db, principal.userId, conversationId)
  const actor = { userId: principal.userId, siteRole: principal.role }
  const now = deps.clock.now()
  enforce(access, actor, 'view', now)
  enforce(access, actor, 'read_messages', now)
  if (!access.member) throw new AppError('NOT_FOUND', 'Conversation not found')
  return access.member
}

/** The newest page, ascending; used by the message list and as the baseline of a sync reset. */
export async function latestMessages(
  db: DbOrTx,
  viewer: Viewer,
  conversationId: string,
  limit: number,
): Promise<{ rows: MessageRow[]; hasMoreBefore: boolean }> {
  const found = await db
    .select()
    .from(messages)
    .where(visibleTo(db, viewer, conversationId))
    .orderBy(desc(messages.seq))
    .limit(limit + 1)
  return { rows: found.slice(0, limit).reverse(), hasMoreBefore: found.length > limit }
}

async function anyVisible(
  db: DbOrTx,
  viewer: Viewer,
  conversationId: string,
  condition: ReturnType<typeof lt>,
): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(messages)
    .where(and(visibleTo(db, viewer, conversationId), condition))
    .limit(1)
  return row !== undefined
}

/**
 * Messages in ascending order around an anchor or at the end. Both flags look past the ends of the page, over what the
 * viewer may see, so "more" never means messages they cannot open.
 */
export async function listMessages(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  query: MessagesQuery,
): Promise<MessagesResponse> {
  const member = await memberOf(deps.db, deps, principal, conversationId)
  const viewer: Viewer = { userId: principal.userId, visibleFromSeq: member.visibleFromSeq }
  const limit = query.limit ?? LIMITS.messagePageDefault
  const where = visibleTo(deps.db, viewer, conversationId)

  // A page asks for one row more than it returns on the side it pages towards: the extra row is the answer to "is there
  // more that way", so only the far side still needs a probe of its own.
  const older = async (belowSeq: number, count: number) => {
    const found = await deps.db
      .select()
      .from(messages)
      .where(and(where, lt(messages.seq, belowSeq)))
      .orderBy(desc(messages.seq))
      .limit(count + 1)
    return { rows: found.slice(0, count).reverse(), more: found.length > count }
  }
  const newer = async (condition: SQL, count: number) => {
    const found = await deps.db
      .select()
      .from(messages)
      .where(and(where, condition))
      .orderBy(asc(messages.seq))
      .limit(count + 1)
    return { rows: found.slice(0, count), more: found.length > count }
  }

  let rows: MessageRow[]
  let hasMoreBefore: boolean
  let hasMoreAfter: boolean
  if (query.beforeSeq !== undefined) {
    const page = await older(query.beforeSeq, limit)
    rows = page.rows
    hasMoreBefore = page.more
    // An empty page ends just below the anchor, so the flag still makes sense then.
    const hi = rows[rows.length - 1]?.seq ?? query.beforeSeq - 1
    hasMoreAfter = await anyVisible(deps.db, viewer, conversationId, gt(messages.seq, hi))
  } else if (query.afterSeq !== undefined) {
    const page = await newer(gt(messages.seq, query.afterSeq), limit)
    rows = page.rows
    hasMoreAfter = page.more
    const lo = rows[0]?.seq ?? query.afterSeq + 1
    hasMoreBefore = await anyVisible(deps.db, viewer, conversationId, lt(messages.seq, lo))
  } else if (query.aroundSeq !== undefined) {
    const half = Math.floor(limit / 2)
    const before = half > 0 ? await older(query.aroundSeq, half) : null
    const after = await newer(
      gte(messages.seq, query.aroundSeq),
      limit - (before?.rows.length ?? 0),
    )
    rows = [...(before?.rows ?? []), ...after.rows]
    hasMoreAfter = after.more
    // A page of one has no older half to look at, so it asks.
    hasMoreBefore = before
      ? before.more
      : await anyVisible(
          deps.db,
          viewer,
          conversationId,
          lt(messages.seq, rows[0]?.seq ?? query.aroundSeq),
        )
  } else {
    const page = await latestMessages(deps.db, viewer, conversationId, limit)
    rows = page.rows
    hasMoreBefore = page.hasMoreBefore
    // The newest page ends at the newest message the viewer may see.
    hasMoreAfter = false
  }

  const projected = await projectMessages(deps.db, viewer, rows)
  return { ...projected, hasMoreBefore, hasMoreAfter }
}

/** One message as the reader may see it; one they may not is "not found", whether it exists or not. */
export async function getMessage(
  deps: Deps,
  principal: SessionPrincipal,
  messageId: string,
): Promise<MessageEnvelope> {
  const missing = () => new AppError('NOT_FOUND', 'Message not found')
  const [found] = await deps.db
    .select({ row: messages, hidden: hiddenMark(deps.db, principal.userId) })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1)
  if (!found) throw missing()
  const { row, hidden } = found
  let member: MemberRow
  try {
    member = await memberOf(deps.db, deps, principal, row.conversationId)
  } catch (error) {
    if (error instanceof AppError && (error.status === 403 || error.status === 404)) throw missing()
    throw error
  }
  // Before the reader's boundary, or deleted by them for themselves: not theirs to open.
  if (hidden || row.seq <= member.visibleFromSeq) throw missing()
  const viewer: Viewer = { userId: principal.userId, visibleFromSeq: member.visibleFromSeq }
  const projected = await projectMessages(deps.db, viewer, [row])
  const message = projected.messages[0]
  if (!message) throw missing()
  return { message, users: projected.users }
}

// ───────── sending ─────────

/** Who a message is written for: their rights decide, whatever authority (session or delegation) was checked first. */
export type MessageActor = { userId: string; role: UserRole }

export type WriteMessageInput = {
  clientId: string
  body: string
  replyToId?: string | null
  attachmentIds?: readonly string[]
}

export type WriteMessageOptions = {
  /** Set by the trusted entry point, never by a request (INV-28). Only `interactive` moves the sender's read position. */
  executionSource: Extract<
    ExecutionSource,
    'interactive' | 'agent_effect' | 'scheduled' | 'offline_replay'
  >
  meta?: MessageMeta
}

export type WrittenMessage = {
  row: MessageRow
  created: boolean
  conversation: ConversationRow
  member: MemberRow
  viewer: Viewer
  userRole: UserRole
}

/** The other member of a direct message, or null; locked with the sender because writing changes their view too. */
export async function directPeerOf(
  db: DbOrTx,
  senderId: string,
  conversationId: string,
): Promise<string | null> {
  const members = await db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(eq(conversationMembers.conversationId, conversationId), eq(conversations.kind, 'dm')),
    )
  return members.some((row) => row.userId === senderId)
    ? (members.find((row) => row.userId !== senderId)?.userId ?? null)
    : null
}

/**
 * The transaction body of every user message, whichever way it arrives: typed by the person, sent by the assistant after
 * their approval, or delivered by a scheduled task. The caller has locked the sender (and the peer of a direct message)
 * and re-checked the authority it acts under; this checks the conversation rights and writes everything at once: the
 * sequence numbers, the message, its attachments and mentions, the sync log and the realtime hints (docs/03 section 5.1).
 * The same `clientId` with the same request returns the stored message; with another request it is a conflict.
 */
export async function writeMessage(
  tx: Tx,
  deps: Deps,
  actor: MessageActor,
  conversationId: string,
  input: WriteMessageInput,
  options: WriteMessageOptions,
): Promise<WrittenMessage> {
  const attachmentIds = [...(input.attachmentIds ?? [])]
  if (new Set(attachmentIds).size !== attachmentIds.length)
    throw new AppError('VALIDATION_FAILED', 'Duplicate attachment')
  const body = normalizeBody(input.body)
  if (body.length === 0 && attachmentIds.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A message needs a body', {
      details: { field: 'body' },
    })
  }
  const requestHash = fingerprint({
    v: 1,
    conversationId,
    body,
    replyToId: input.replyToId ?? null,
    attachments: attachmentIds,
  })
  const now = deps.clock.now()
  const rights = { userId: actor.userId, siteRole: actor.role }
  const access = await loadAccess(tx, actor.userId, conversationId, { lock: true })
  enforce(access, rights, 'view', now)
  enforce(access, rights, 'read_messages', now)
  const member = access.member
  if (!member) throw new AppError('NOT_FOUND', 'Conversation not found')
  const conversation = access.conversation
  const viewer: Viewer = { userId: actor.userId, visibleFromSeq: member.visibleFromSeq }

  const [existing] = await tx
    .select()
    .from(messages)
    .where(and(eq(messages.senderId, actor.userId), eq(messages.clientId, input.clientId)))
  if (existing) {
    if (existing.conversationId !== conversationId || existing.requestHash !== requestHash) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'The clientId was used for a different message')
    }
    // A retry is answered with the stored message only while it is still the sender's to see. Somebody who left and
    // came back has a new boundary, and what was said before it is no longer theirs, not even their own words
    // (D-035, INV-09): the retry is judged against the membership they have now.
    if (existing.seq <= member.visibleFromSeq) throw new AppError('NOT_FOUND', 'Message not found')
    return { row: existing, created: false, conversation, member, viewer, userRole: actor.role }
  }

  enforce(access, rights, 'send_message', now)
  // The other side of a direct message, read once: whether they can still receive, and whether this message has to
  // bring the conversation back into their list. Their user row is locked by the caller and the conversation by this
  // transaction, so neither answer can change before the end of it.
  let peer: { userId: string; membershipId: string; hiddenAt: Date | null } | undefined
  if (conversation.kind === 'dm') {
    const [other] = await tx
      .select({
        userId: conversationMembers.userId,
        membershipId: conversationMembers.membershipId,
        hiddenAt: conversationMembers.hiddenAt,
        deletedAt: users.deletedAt,
      })
      .from(conversationMembers)
      .innerJoin(users, eq(users.id, conversationMembers.userId))
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          ne(conversationMembers.userId, actor.userId),
        ),
      )
      .limit(1)
    if (!other || other.deletedAt !== null) {
      throw new AppError('FORBIDDEN', 'The other person can no longer receive messages', {
        details: { reason: 'peer_unavailable' },
      })
    }
    peer = other
  }

  let replyToId: string | null = null
  if (input.replyToId) {
    const unavailable = () =>
      new AppError('VALIDATION_FAILED', 'That message cannot be replied to', {
        details: { field: 'replyToId', reason: 'unavailable' },
      })
    const [target] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.id, input.replyToId), visibleTo(tx, viewer, conversationId)))
    // Not found, from another conversation, before the boundary, hidden, a system line or already withdrawn: all the
    // same answer, so a quote cannot be used to probe for messages (docs/05 section 2).
    if (!target || target.kind === 'system' || target.recalledAt || target.deletedAt)
      throw unavailable()
    replyToId = target.id
  }

  const { seq, changeSeq } = await allocateMessageSeq(tx, deps, conversationId)
  const id = deps.newId()
  const [row] = await tx
    .insert(messages)
    .values({
      id,
      conversationId,
      seq,
      changeSeq,
      senderId: actor.userId,
      kind: 'user',
      status: 'sent',
      body,
      replyToId,
      clientId: input.clientId,
      requestHash,
      executionSource: options.executionSource,
      meta: options.meta ?? {},
      createdAt: now,
    })
    .returning()
  if (!row) throw new Error('message was not created')
  for (const [position, attachmentId] of attachmentIds.entries()) {
    const [file] = await tx
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId))
      .for('update')
    if (
      !file ||
      file.uploaderId !== actor.userId ||
      file.purpose !== 'message' ||
      file.status !== 'ready' ||
      file.messageId !== null ||
      file.privacyClass !== 'standard' ||
      (file.conversationId !== null && file.conversationId !== conversationId)
    )
      throw new AppError('VALIDATION_FAILED', 'Attachment unavailable', {
        details: { field: 'attachmentIds' },
      })
    await tx
      .update(attachments)
      .set({ messageId: id, conversationId, position, version: sql`${attachments.version} + 1` })
      .where(eq(attachments.id, attachmentId))
  }
  await insertMentions(tx, id, conversationId, body)
  await recordMessageChange(tx, deps, {
    conversationId,
    messageId: id,
    changeSeq,
    kind: 'message_created',
    inserted: row,
  })
  // Who this concerns is worked out after the commit, from the message as it then stands (docs/03 section 5.1 step 4).
  if (conversation.kind !== 'agent')
    await enqueueMessageNotifications(tx, deps, id, mentionIds(body))

  // Only the person's own interactive send says they have seen everything up to it (INV-28, AT-32); any message they
  // write brings a direct message they had hidden back into view.
  const interactive = options.executionSource === 'interactive'
  if (interactive || member.hiddenAt) {
    await recordViewerChange(tx, deps, {
      userId: actor.userId,
      conversationId,
      membershipId: member.membershipId,
      state: 'active',
      memberPatch: {
        ...(interactive
          ? { lastReadSeq: sql`greatest(${conversationMembers.lastReadSeq}, ${seq})` }
          : {}),
        ...(member.hiddenAt ? { hiddenAt: null } : {}),
      },
    })
  }
  if (peer?.hiddenAt) {
    await recordViewerChange(tx, deps, {
      userId: peer.userId,
      conversationId,
      membershipId: peer.membershipId,
      state: 'active',
      memberPatch: { hiddenAt: null },
    })
  }
  return { row, created: true, conversation, member, viewer, userRole: actor.role }
}

/**
 * Sends a message as an interactive act of the signed-in person. The whole of it commits or none of it does: the
 * sequence numbers, the message, the sync log, the sender's read position and the realtime hints (docs/03 section 5.1).
 * The same `clientId` with the same request returns the same message; with another request, or for another
 * conversation, it is a conflict (INV-03, D-066).
 */
export async function sendMessage(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  input: SendMessageRequest,
): Promise<{ envelope: MessageEnvelope; created: boolean }> {
  return await sendAs(deps, principal, conversationId, input, { source: 'interactive' })
}

/**
 * Sends a plain-text message that was written while the connection was down (M6, docs/05 section 3.4): the same write as
 * any other, with its source fixed on the server as `offline_replay`, which never moves the person's read position (AT-32).
 * It is accepted only within 24 hours of being queued and only under the membership it was written under; the same
 * `clientId` answers with the message already sent, so a repeat after a lost answer is harmless.
 */
export async function replayMessage(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  input: ReplayMessageRequest,
): Promise<{ envelope: MessageEnvelope; created: boolean }> {
  const age = deps.clock.now().getTime() - Date.parse(input.queuedAt)
  // A clock that runs a little fast is tolerated; a message from the future is not a queue entry at all.
  if (age < -5 * 60_000) {
    throw new AppError('VALIDATION_FAILED', 'The queue time is in the future', {
      details: { field: 'queuedAt' },
    })
  }
  if (age > LIMITS.offlineQueueMaxAgeMs) {
    throw new AppError('WINDOW_EXPIRED', 'The queued message is too old to be sent on its own', {
      details: { reason: 'queue_expired' },
    })
  }
  return await sendAs(
    deps,
    principal,
    conversationId,
    { clientId: input.clientId, body: input.body, replyToId: input.replyToId },
    { source: 'offline_replay', membershipId: input.membershipId },
  )
}

async function sendAs(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  input: SendMessageRequest,
  how: { source: 'interactive' } | { source: 'offline_replay'; membershipId: string },
): Promise<{ envelope: MessageEnvelope; created: boolean }> {
  // A direct message changes the other person's view too (it brings the conversation out of hiding), so both are locked.
  const peerId = await directPeerOf(deps.db, principal.userId, conversationId)
  return await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal, { alsoLock: peerId ? [peerId] : [] })
    const written = await writeMessage(
      tx,
      deps,
      { userId: principal.userId, role: user.role },
      conversationId,
      {
        clientId: input.clientId,
        body: input.body ?? '',
        replyToId: input.replyToId,
        attachmentIds: input.attachmentIds,
      },
      { executionSource: how.source },
    )
    const { row, conversation, viewer } = written
    if (how.source === 'offline_replay') {
      // What was written for a membership that has ended (left and came back) is not sent into the new one (D-171), and
      // the assistant's own conversations are never fed from a queue.
      if (written.member.membershipId !== how.membershipId) {
        throw new AppError(
          'CONFLICT',
          'The conversation membership changed since this was written',
          {
            details: { reason: 'membership_changed' },
          },
        )
      }
      if (conversation.kind === 'agent') {
        throw new AppError(
          'VALIDATION_FAILED',
          'Assistant conversations are not sent from the offline queue',
          {
            details: { reason: 'agent_conversation' },
          },
        )
      }
    }
    if (!written.created) {
      const projected = await projectMessages(tx, viewer, [row])
      const message = projected.messages[0]
      if (!message) throw new AppError('NOT_FOUND', 'Message not found')
      return { envelope: { message, users: projected.users }, created: false }
    }

    if (conversation.kind === 'agent') {
      const [context] = await tx
        .select()
        .from(agentContexts)
        .where(eq(agentContexts.conversationId, conversationId))
      await enqueueRunForSource(tx, deps, principal, row, {
        trigger: conversation.panelForConversationId ? 'panel' : 'agent_chat',
        mode: user.settings.agentMode === 'deep' ? 'deep' : 'fast',
        scope: conversation.panelForConversationId
          ? (context?.readScope ?? 'current_conversation')
          : 'all_accessible',
        contextId: conversation.panelForConversationId ?? null,
        allowRefusal: true,
      })
    } else if (
      ['group', 'channel'].includes(conversation.kind) &&
      conversation.settings.agentEnabled !== false
    ) {
      // Most messages mention nobody, and then there is nothing to look up.
      const mentioned = mentionIds(row.body ?? '')
      const [bot] =
        mentioned.length > 0
          ? await tx
              .select({ id: users.id })
              .from(users)
              .where(
                and(
                  eq(users.username, deps.config.product.agentUsername),
                  eq(users.isBot, true),
                  inArray(users.id, mentioned),
                ),
              )
          : []
      if (bot)
        await enqueueRunForSource(tx, deps, principal, row, {
          trigger: 'mention',
          mode: 'fast',
          scope: 'current_conversation',
          contextId: conversationId,
          allowRefusal: true,
        })
    }
    const projected = await projectMessages(tx, viewer, [row])
    const message = projected.messages[0]
    if (!message) throw new Error('message projection failed')
    return { envelope: { message, users: projected.users }, created: true }
  })
}

// ───────── changing and withdrawing ─────────

async function messageHead(deps: Deps, messageId: string): Promise<{ conversationId: string }> {
  const [head] = await deps.db
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, messageId))
  if (!head) throw new AppError('NOT_FOUND', 'Message not found')
  return head
}

/**
 * The message of a conversation one may not see does not exist, and says so in the same words as one that never did:
 * "Conversation not found" would tell a stranger that the id belongs to a private conversation.
 */
function enforceView(
  access: Parameters<typeof enforce>[0],
  actor: Parameters<typeof enforce>[1],
  now: Date,
): void {
  try {
    enforce(access, actor, 'view', now)
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') {
      throw new AppError('NOT_FOUND', 'Message not found')
    }
    throw error
  }
}

type WriteContext = {
  now: Date
  row: MessageRow
  /** null for a site administrator moderating a conversation they are not in. */
  member: MemberRow | null
  viewer: Viewer
}

/**
 * Locks the conversation (every change to its messages is serialized by it), re-checks the caller and loads the message
 * as the caller may see it. A message they may not see does not exist for them.
 */
async function withMessage<T>(
  deps: Deps,
  principal: SessionPrincipal,
  messageId: string,
  action: 'edit_message' | 'recall_message' | 'delete_message_of_others',
  run: (tx: Tx, context: WriteContext, conversationId: string) => Promise<T>,
): Promise<T> {
  const head = await messageHead(deps, messageId)
  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const attachmentOwners = await tx
      .select({ id: attachments.uploaderId })
      .from(attachments)
      .where(eq(attachments.messageId, messageId))
    const user = await lockAndRevalidate(tx, deps, principal, {
      alsoLock: attachmentOwners.map((owner) => owner.id),
    })
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await loadAccess(tx, principal.userId, head.conversationId, { lock: true })
    enforceView(access, actor, now)
    const [row] = await tx.select().from(messages).where(eq(messages.id, messageId))
    if (!row || row.conversationId !== head.conversationId)
      throw new AppError('NOT_FOUND', 'Message not found')
    const member = access.member
    // A site administrator who is not in the conversation moderates; everyone else works with their own boundary.
    if (!member && action !== 'delete_message_of_others')
      enforce(access, actor, 'read_messages', now)
    if (member && row.seq <= member.visibleFromSeq)
      throw new AppError('NOT_FOUND', 'Message not found')
    const viewer: Viewer = { userId: principal.userId, visibleFromSeq: member?.visibleFromSeq ?? 0 }
    enforce(access, actor, action, now)
    return await run(tx, { now, row, member, viewer }, head.conversationId)
  })
}

async function envelopeOf(
  tx: DbOrTx,
  viewer: Viewer,
  conversationId: string,
  messageId: string,
): Promise<MessageEnvelope> {
  const [row] = await tx.select().from(messages).where(eq(messages.id, messageId))
  if (!row || row.conversationId !== conversationId)
    throw new AppError('NOT_FOUND', 'Message not found')
  const projected = await projectMessages(tx, viewer, [row])
  const message = projected.messages[0]
  if (!message) throw new AppError('NOT_FOUND', 'Message not found')
  return { message, users: projected.users }
}

/**
 * The author edits within 24 hours. The change is conditional on the `changeSeq` the editor saw, so two devices cannot
 * overwrite each other. An edit is not a new message: nobody is notified and no assistant run starts (docs/01).
 */
export async function editMessage(
  deps: Deps,
  principal: SessionPrincipal,
  messageId: string,
  input: EditMessageRequest,
): Promise<MessageEnvelope> {
  const body = normalizeBody(input.body)
  if (body.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'A message needs a body', {
      details: { field: 'body' },
    })
  }
  return await withMessage(
    deps,
    principal,
    messageId,
    'edit_message',
    async (tx, ctx, conversationId) => {
      await assertDeletionMutable(tx, 'message', messageId)
      const { row, now, viewer } = ctx
      if (row.kind !== 'user' || row.senderId !== principal.userId) {
        throw new AppError('FORBIDDEN', 'Only the author can edit a message', {
          details: { reason: 'not_author' },
        })
      }
      if (row.recalledAt !== null || row.deletedAt !== null) {
        throw new AppError('CONFLICT', 'The message was withdrawn', { details: { reason: 'gone' } })
      }
      const limits = await readSiteLimits(deps, tx)
      if (now.getTime() - row.createdAt.getTime() > limits.messageEditWindowMs) {
        throw new AppError('WINDOW_EXPIRED', 'The time to edit this message has passed', {
          details: { windowMs: limits.messageEditWindowMs },
        })
      }
      if (input.expectedChangeSeq !== row.changeSeq) {
        throw new AppError('VERSION_CONFLICT', 'The message changed; reload and try again', {
          details: { changeSeq: row.changeSeq },
        })
      }
      if (body === row.body) return await envelopeOf(tx, viewer, conversationId, messageId)

      const changeSeq = await allocateChangeSeq(tx, deps, conversationId)
      await tx.delete(messageMentions).where(eq(messageMentions.messageId, messageId))
      await insertMentions(tx, messageId, conversationId, body)
      await tx
        .update(messages)
        .set({
          body,
          editedAt: now,
          contentVersion: sql`${messages.contentVersion} + 1`,
          changeSeq,
        })
        .where(eq(messages.id, messageId))
      await recordMessageChange(tx, deps, {
        conversationId,
        messageId,
        changeSeq,
        kind: 'message_edited',
      })
      return await envelopeOf(tx, viewer, conversationId, messageId)
    },
  )
}

/**
 * The author withdraws within two minutes (the server adds five seconds of grace for the network). The body is cleared
 * in the same transaction, so nothing of it stays online (INV-06). Repeating the request returns the same end state.
 */
export async function requestMessageDeletion(
  deps: Deps,
  principal: SessionPrincipal,
  messageId: string,
  action: 'message_recall' | 'message_delete',
): Promise<MessageEnvelope | DeletionOperation | void> {
  if (!deps.deletionJournal)
    return action === 'message_recall'
      ? await recallMessage(deps, principal, messageId)
      : await deleteMessageAsModerator(deps, principal, messageId)
  const prepared = await withMessage(
    deps,
    principal,
    messageId,
    action === 'message_recall' ? 'recall_message' : 'delete_message_of_others',
    async (tx, ctx, conversationId) => {
      const existing = await findDeletion(tx, principal.userId, action, messageId)
      if (existing) return existing
      const { row, now } = ctx
      if (action === 'message_recall') {
        const limits = await readSiteLimits(deps, tx)
        if (row.kind !== 'user' || row.senderId !== principal.userId)
          throw new AppError('FORBIDDEN', 'Only the author can recall a message', {
            details: { reason: 'not_author' },
          })
        if (
          !row.recalledAt &&
          !row.deletedAt &&
          now.getTime() - row.createdAt.getTime() >
            limits.messageRecallWindowMs + LIMITS.messageRecallGraceMs
        )
          throw new AppError('WINDOW_EXPIRED', 'The time to recall this message has passed', {
            details: { windowMs: limits.messageRecallWindowMs },
          })
      } else if (row.kind === 'system') {
        throw new AppError('FORBIDDEN', 'System messages cannot be deleted', {
          details: { reason: 'not_deletable' },
        })
      }
      if (row.recalledAt || row.deletedAt) return null
      return await prepareDeletion(tx, deps, principal.userId, {
        action,
        target: { id: messageId, conversationId, contentVersion: row.contentVersion },
      })
    },
  )
  if (prepared) {
    const status = await settleDeletion(deps, prepared.id, applyDeletion)
    if (status.status !== 'completed') return status
  }
  if (action === 'message_recall')
    return await withMessage(
      deps,
      principal,
      messageId,
      'recall_message',
      async (tx, ctx, id) => await envelopeOf(tx, ctx.viewer, id, messageId),
    )
}

/** Same frozen identifier-only action online and during isolated restore; independent of the original session. */
export async function applyMessageDeletion(
  tx: Tx,
  deps: Deps,
  intent: Extract<DeletionIntent, { action: 'message_recall' | 'message_delete' }>,
  actorId: string | null,
): Promise<void> {
  await tx
    .update(reports)
    .set({ details: null, resolutionNote: null })
    .where(eq(reports.messageId, intent.target.id))
  await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, intent.target.conversationId))
    .for('update')
  const [row] = await tx.select().from(messages).where(eq(messages.id, intent.target.id))
  if (!row || row.recalledAt || row.deletedAt) return
  if (
    row.conversationId !== intent.target.conversationId ||
    row.contentVersion > intent.target.contentVersion
  )
    throw new Error('frozen message identity mismatch')
  const changeSeq = await allocateChangeSeq(tx, deps, row.conversationId)
  await withdrawAttachments(tx, deps, row.id)
  await tx
    .update(messages)
    .set({
      body: null,
      contentVersion: sql`${messages.contentVersion} + 1`,
      changeSeq,
      ...(intent.action === 'message_recall'
        ? { recalledAt: deps.clock.now() }
        : { deletedAt: deps.clock.now(), deletedBy: actorId }),
    })
    .where(eq(messages.id, row.id))
  await recordMessageChange(tx, deps, {
    conversationId: row.conversationId,
    messageId: row.id,
    changeSeq,
    kind: intent.action === 'message_recall' ? 'message_recalled' : 'message_deleted',
  })
  if (intent.action === 'message_delete')
    await writeAudit(tx, {
      actorId,
      action: 'message.delete',
      targetType: 'message',
      targetId: row.id,
      metadata: { conversation: row.conversationId },
    })
}

export async function recallMessage(
  deps: Deps,
  principal: SessionPrincipal,
  messageId: string,
): Promise<MessageEnvelope> {
  if (deps.deletionJournal) throw new Error('journaled recall requires requestMessageDeletion')
  return await withMessage(
    deps,
    principal,
    messageId,
    'recall_message',
    async (tx, ctx, conversationId) => {
      const { row, now, viewer } = ctx
      if (row.kind !== 'user' || row.senderId !== principal.userId) {
        throw new AppError('FORBIDDEN', 'Only the author can recall a message', {
          details: { reason: 'not_author' },
        })
      }
      if (row.recalledAt !== null || row.deletedAt !== null) {
        return await envelopeOf(tx, viewer, conversationId, messageId)
      }
      const limits = await readSiteLimits(deps, tx)
      if (
        now.getTime() - row.createdAt.getTime() >
        limits.messageRecallWindowMs + LIMITS.messageRecallGraceMs
      ) {
        throw new AppError('WINDOW_EXPIRED', 'The time to recall this message has passed', {
          details: { windowMs: limits.messageRecallWindowMs },
        })
      }
      const changeSeq = await allocateChangeSeq(tx, deps, conversationId)
      await withdrawAttachments(tx, deps, messageId)
      await tx
        .update(messages)
        .set({
          body: null,
          recalledAt: now,
          contentVersion: sql`${messages.contentVersion} + 1`,
          changeSeq,
        })
        .where(eq(messages.id, messageId))
      await recordMessageChange(tx, deps, {
        conversationId,
        messageId,
        changeSeq,
        kind: 'message_recalled',
      })
      return await envelopeOf(tx, viewer, conversationId, messageId)
    },
  )
}

/**
 * An owner, an administrator or a site administrator deletes someone's message for everybody; the body is cleared and
 * the deletion is audited without the content (SEC-21). Repeating it, or deleting what was already withdrawn, is a no-op.
 */
export async function deleteMessageAsModerator(
  deps: Deps,
  principal: SessionPrincipal,
  messageId: string,
): Promise<void> {
  if (deps.deletionJournal) throw new Error('journaled removal requires requestMessageDeletion')
  await withMessage(
    deps,
    principal,
    messageId,
    'delete_message_of_others',
    async (tx, ctx, conversationId) => {
      const { row, now } = ctx
      if (row.kind === 'system') {
        throw new AppError('FORBIDDEN', 'System messages cannot be deleted', {
          details: { reason: 'not_deletable' },
        })
      }
      if (row.recalledAt !== null || row.deletedAt !== null) return
      const changeSeq = await allocateChangeSeq(tx, deps, conversationId)
      await withdrawAttachments(tx, deps, messageId)
      await tx
        .update(messages)
        .set({
          body: null,
          deletedAt: now,
          deletedBy: principal.userId,
          contentVersion: sql`${messages.contentVersion} + 1`,
          changeSeq,
        })
        .where(eq(messages.id, messageId))
      await recordMessageChange(tx, deps, {
        conversationId,
        messageId,
        changeSeq,
        kind: 'message_deleted',
      })
      await writeAudit(tx, {
        actorId: principal.userId,
        action: 'message.delete',
        targetType: 'message',
        targetId: messageId,
        metadata: { conversation: conversationId, siteAdmin: ctx.member === null },
      })
    },
  )
}

/**
 * "Delete for me": a view preference, not a withdrawal (docs/01 section 4.5). The mark goes into the person's own log so
 * other devices drop the message too, and the conversation's preview is recomputed for them.
 */
export async function hideMessage(
  deps: Deps,
  principal: SessionPrincipal,
  messageId: string,
): Promise<void> {
  const head = await messageHead(deps, messageId)
  await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal)
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await loadAccess(tx, principal.userId, head.conversationId)
    enforceView(access, actor, now)
    enforce(access, actor, 'hide_message', now)
    const member = access.member
    if (!member) throw new AppError('NOT_FOUND', 'Message not found')
    const [row] = await tx
      .select({ seq: messages.seq })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.conversationId, head.conversationId)))
    if (!row || row.seq <= member.visibleFromSeq)
      throw new AppError('NOT_FOUND', 'Message not found')

    const marked = await tx
      .insert(messageHidden)
      .values({ userId: principal.userId, messageId, hiddenAt: now })
      .onConflictDoNothing()
      .returning({ messageId: messageHidden.messageId })
    if (marked.length === 0) return
    await recordUserChange(tx, deps, {
      userId: principal.userId,
      entityType: 'message_hidden',
      entityId: messageId,
    })
    await recordViewerChange(tx, deps, {
      userId: principal.userId,
      conversationId: head.conversationId,
      membershipId: member.membershipId,
      state: member.hiddenAt ? 'hidden' : 'active',
    })
  })
}

/**
 * Records whom a body mentions: members of the conversation and the assistant, nobody else. A new message has no rows
 * yet; an edit deletes the old ones first. Mentions never create notification intents on edits; M6 consumes message
 * creation separately.
 */
async function insertMentions(tx: DbOrTx, messageId: string, conversationId: string, body: string) {
  const ids = mentionIds(body)
  if (!ids.length) return
  const accepted = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, ids),
        or(
          eq(users.isBot, true),
          exists(
            tx
              .select({ one: sql`1` })
              .from(conversationMembers)
              .where(
                and(
                  eq(conversationMembers.conversationId, conversationId),
                  eq(conversationMembers.userId, users.id),
                ),
              ),
          ),
        ),
      ),
    )
  if (accepted.length)
    await tx.insert(messageMentions).values(accepted.map(({ id }) => ({ messageId, userId: id })))
}
async function withdrawAttachments(tx: import('@chatapp/db').Tx, deps: Deps, messageId: string) {
  await tx
    .update(reports)
    .set({ details: null, resolutionNote: null })
    .where(eq(reports.messageId, messageId))
  await tx.delete(messageMentions).where(eq(messageMentions.messageId, messageId))
  const files = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
  if (!files.length) return
  await lockStorage(tx)
  for (const file of files) await retireAttachment(tx, deps, file.id)
}
