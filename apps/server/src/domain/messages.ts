/**
 * Messages (docs/05 section 3.4, docs/03 sections 5.1 and 5.3, docs/01 section 4.5): sending in one transaction with the
 * sequence numbers, the sync log and the realtime hint; reading as the viewer sees it; edit, recall, delete-for-me and
 * administrator delete. A message is always projected for one reader: nothing from before they joined, nothing they hid,
 * and a reply quote that reveals nothing they may not see (INV-09, INV-12).
 */
import {
  AppError,
  type EditMessageRequest,
  LIMITS,
  type Message,
  type MessageEnvelope,
  type MessagesQuery,
  type MessagesResponse,
  mentionIds,
  plainMessageText,
  type ReplyTo,
  type SendMessageRequest,
  type SystemEvent,
  truncateCodePoints,
  type UsersDictionary,
} from '@chatapp/contracts'
import {
  attachments,
  conversationMembers,
  conversations,
  type DbOrTx,
  messageHidden,
  messageMentions,
  messages,
  type Tx,
  users,
} from '@chatapp/db'
import { and, asc, desc, eq, gt, inArray, lt, notExists, sql } from 'drizzle-orm'
import { fingerprint } from '../lib/crypto.ts'
import { attachmentDto, lockStorage } from './attachment-common.ts'
import { writeAudit } from './audit.ts'
import { enforce, loadAccess, type MemberRow } from './authorize.ts'
import {
  allocateChangeSeq,
  allocateMessageSeq,
  recordMessageChange,
  recordUserChange,
  recordViewerChange,
} from './changes.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate, lockUsers } from './sessions.ts'
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
        attachmentKind: sql<
          'image' | 'video' | 'audio' | 'file' | null
        >`(select a.kind from ${attachments} a where a.message_id = "messages"."id" and a.status = 'ready' and a.privacy_class = 'standard' order by a.position limit 1)`,
        recalledAt: messages.recalledAt,
        deletedAt: messages.deletedAt,
      })
      .from(messages)
      .where(inArray(messages.id, replyIds))
    for (const row of found) targets.set(row.id, row)
    const marks = await db
      .select({ messageId: messageHidden.messageId })
      .from(messageHidden)
      .where(
        and(eq(messageHidden.userId, viewer.userId), inArray(messageHidden.messageId, replyIds)),
      )
    for (const mark of marks) hidden.add(mark.messageId)
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
                target.excerpt,
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
  const [files, mentioned] = rowIds.length
    ? await Promise.all([
        db
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
          .orderBy(asc(attachments.position)),
        db.select().from(messageMentions).where(inArray(messageMentions.messageId, rowIds)),
      ])
    : [[], []]
  const projected: Message[] = rows.map((row) => {
    const gone = row.recalledAt !== null || row.deletedAt !== null
    return {
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

  let rows: MessageRow[]
  // Where the page would have started and ended if it were empty, so the two flags still make sense then.
  let lo: number
  let hi: number
  if (query.beforeSeq !== undefined) {
    rows = (
      await deps.db
        .select()
        .from(messages)
        .where(and(where, lt(messages.seq, query.beforeSeq)))
        .orderBy(desc(messages.seq))
        .limit(limit)
    ).reverse()
    lo = rows[0]?.seq ?? query.beforeSeq
    hi = rows[rows.length - 1]?.seq ?? query.beforeSeq - 1
  } else if (query.afterSeq !== undefined) {
    rows = await deps.db
      .select()
      .from(messages)
      .where(and(where, gt(messages.seq, query.afterSeq)))
      .orderBy(asc(messages.seq))
      .limit(limit)
    lo = rows[0]?.seq ?? query.afterSeq + 1
    hi = rows[rows.length - 1]?.seq ?? query.afterSeq
  } else if (query.aroundSeq !== undefined) {
    const half = Math.floor(limit / 2)
    const older =
      half > 0
        ? (
            await deps.db
              .select()
              .from(messages)
              .where(and(where, lt(messages.seq, query.aroundSeq)))
              .orderBy(desc(messages.seq))
              .limit(half)
          ).reverse()
        : []
    const newer = await deps.db
      .select()
      .from(messages)
      .where(and(where, sql`${messages.seq} >= ${query.aroundSeq}`))
      .orderBy(asc(messages.seq))
      .limit(limit - older.length)
    rows = [...older, ...newer]
    lo = rows[0]?.seq ?? query.aroundSeq
    hi = rows[rows.length - 1]?.seq ?? query.aroundSeq - 1
  } else {
    rows = (await latestMessages(deps.db, viewer, conversationId, limit)).rows
    lo = rows[0]?.seq ?? 0
    hi = rows[rows.length - 1]?.seq ?? Number.MAX_SAFE_INTEGER
  }

  const [hasMoreBefore, hasMoreAfter] = await Promise.all([
    anyVisible(deps.db, viewer, conversationId, lt(messages.seq, lo)),
    anyVisible(deps.db, viewer, conversationId, gt(messages.seq, hi)),
  ])
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
  const [row] = await deps.db.select().from(messages).where(eq(messages.id, messageId)).limit(1)
  if (!row) throw missing()
  let member: MemberRow
  try {
    member = await memberOf(deps.db, deps, principal, row.conversationId)
  } catch (error) {
    if (error instanceof AppError && (error.status === 403 || error.status === 404)) throw missing()
    throw error
  }
  const viewer: Viewer = { userId: principal.userId, visibleFromSeq: member.visibleFromSeq }
  const [visible] = await deps.db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, messageId), visibleTo(deps.db, viewer, row.conversationId)))
  if (!visible) throw missing()
  const projected = await projectMessages(deps.db, viewer, [row])
  const message = projected.messages[0]
  if (!message) throw missing()
  return { message, users: projected.users }
}

// ───────── sending ─────────

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
  const attachmentIds = input.attachmentIds ?? []
  if (new Set(attachmentIds).size !== attachmentIds.length)
    throw new AppError('VALIDATION_FAILED', 'Duplicate attachment')
  const body = normalizeBody(input.body ?? '')
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

  // A direct message changes the other person's view too (it brings the conversation out of hiding), so both are locked.
  const members = await deps.db
    .select({ userId: conversationMembers.userId })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(eq(conversationMembers.conversationId, conversationId), eq(conversations.kind, 'dm')),
    )
  const peerId = members.some((row) => row.userId === principal.userId)
    ? (members.find((row) => row.userId !== principal.userId)?.userId ?? null)
    : null

  return await inTransaction(deps.db, async (tx) => {
    const now = deps.clock.now()
    const user = await lockAndRevalidate(tx, deps, principal, { alsoLock: peerId ? [peerId] : [] })
    const actor = { userId: principal.userId, siteRole: user.role }
    const access = await loadAccess(tx, principal.userId, conversationId, { lock: true })
    enforce(access, actor, 'view', now)
    enforce(access, actor, 'read_messages', now)
    const member = access.member
    if (!member) throw new AppError('NOT_FOUND', 'Conversation not found')
    const conversation = access.conversation
    const viewer: Viewer = { userId: principal.userId, visibleFromSeq: member.visibleFromSeq }

    const [existing] = await tx
      .select()
      .from(messages)
      .where(and(eq(messages.senderId, principal.userId), eq(messages.clientId, input.clientId)))
    if (existing) {
      if (existing.conversationId !== conversationId || existing.requestHash !== requestHash) {
        throw new AppError('IDEMPOTENCY_CONFLICT', 'The clientId was used for a different message')
      }
      // A retry is answered with the stored message only while it is still the sender's to see. Somebody who left and
      // came back has a new boundary, and what was said before it is no longer theirs, not even their own words
      // (D-035, INV-09): the retry is judged against the membership they have now.
      if (existing.seq <= member.visibleFromSeq)
        throw new AppError('NOT_FOUND', 'Message not found')
      const projected = await projectMessages(tx, viewer, [existing])
      const message = projected.messages[0]
      if (!message) throw new AppError('NOT_FOUND', 'Message not found')
      return { envelope: { message, users: projected.users }, created: false }
    }

    enforce(access, actor, 'send_message', now)
    if (conversation.kind === 'dm') {
      const [peer] = peerId ? await lockUsers(tx, [peerId]) : []
      if (!peer || peer.deletedAt !== null) {
        throw new AppError('FORBIDDEN', 'The other person can no longer receive messages', {
          details: { reason: 'peer_unavailable' },
        })
      }
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
        senderId: principal.userId,
        kind: 'user',
        status: 'sent',
        body,
        replyToId,
        clientId: input.clientId,
        requestHash,
        // Set here, by the trusted entry point, never taken from the request (INV-28).
        executionSource: 'interactive',
        meta: {},
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
        file.uploaderId !== principal.userId ||
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
    await replaceMentions(tx, id, conversationId, body)
    await recordMessageChange(tx, deps, {
      conversationId,
      messageId: id,
      changeSeq,
      kind: 'message_created',
    })

    // The sender has seen their own message, and a hidden direct message they write into is hidden no more.
    await tx
      .update(conversationMembers)
      .set({
        lastReadSeq: sql`greatest(${conversationMembers.lastReadSeq}, ${seq})`,
        ...(member.hiddenAt ? { hiddenAt: null } : {}),
      })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, principal.userId),
        ),
      )
    await recordViewerChange(tx, deps, {
      userId: principal.userId,
      conversationId,
      membershipId: member.membershipId,
      state: 'active',
    })
    if (conversation.kind === 'dm' && peerId) {
      const [peerMember] = await tx
        .select()
        .from(conversationMembers)
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, peerId),
          ),
        )
      if (peerMember?.hiddenAt) {
        await tx
          .update(conversationMembers)
          .set({ hiddenAt: null })
          .where(
            and(
              eq(conversationMembers.conversationId, conversationId),
              eq(conversationMembers.userId, peerId),
            ),
          )
        await recordViewerChange(tx, deps, {
          userId: peerId,
          conversationId,
          membershipId: peerMember.membershipId,
          state: 'active',
        })
      }
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
      const { row, now, viewer } = ctx
      if (row.kind !== 'user' || row.senderId !== principal.userId) {
        throw new AppError('FORBIDDEN', 'Only the author can edit a message', {
          details: { reason: 'not_author' },
        })
      }
      if (row.recalledAt !== null || row.deletedAt !== null) {
        throw new AppError('CONFLICT', 'The message was withdrawn', { details: { reason: 'gone' } })
      }
      if (now.getTime() - row.createdAt.getTime() > LIMITS.messageEditWindowMs) {
        throw new AppError('WINDOW_EXPIRED', 'The time to edit this message has passed', {
          details: { windowMs: LIMITS.messageEditWindowMs },
        })
      }
      if (input.expectedChangeSeq !== row.changeSeq) {
        throw new AppError('VERSION_CONFLICT', 'The message changed; reload and try again', {
          details: { changeSeq: row.changeSeq },
        })
      }
      if (body === row.body) return await envelopeOf(tx, viewer, conversationId, messageId)

      const changeSeq = await allocateChangeSeq(tx, deps, conversationId)
      await replaceMentions(tx, messageId, conversationId, body)
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
export async function recallMessage(
  deps: Deps,
  principal: SessionPrincipal,
  messageId: string,
): Promise<MessageEnvelope> {
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
      if (
        now.getTime() - row.createdAt.getTime() >
        LIMITS.messageRecallWindowMs + LIMITS.messageRecallGraceMs
      ) {
        throw new AppError('WINDOW_EXPIRED', 'The time to recall this message has passed', {
          details: { windowMs: LIMITS.messageRecallWindowMs },
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

/** Mentions never create notification intents on edits; M6 consumes message creation separately. */
async function replaceMentions(
  tx: DbOrTx,
  messageId: string,
  conversationId: string,
  body: string,
) {
  await tx.delete(messageMentions).where(eq(messageMentions.messageId, messageId))
  const ids = mentionIds(body)
  if (!ids.length) return
  const members = await tx
    .select({ id: conversationMembers.userId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        inArray(conversationMembers.userId, ids),
      ),
    )
  const bots = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isBot, true), inArray(users.id, ids)))
  const accepted = [...new Set([...members, ...bots].map((row) => row.id))]
  if (accepted.length)
    await tx.insert(messageMentions).values(accepted.map((userId) => ({ messageId, userId })))
}
async function withdrawAttachments(tx: DbOrTx, deps: Deps, messageId: string) {
  await tx.delete(messageMentions).where(eq(messageMentions.messageId, messageId))
  const files = await tx
    .select({ id: attachments.id })
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
  if (!files.length) return
  await lockStorage(tx)
  for (const file of files) await retireAttachment(tx, deps, file.id)
}
