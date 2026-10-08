import {
  AppError,
  type AttachmentPage,
  type AttachmentQuery,
  type SetAvatar,
} from '@chatapp/contracts'
import {
  attachmentObjects,
  attachments,
  conversationMembers,
  conversations,
  type DbOrTx,
  messageHidden,
  messages,
  users,
} from '@chatapp/db'
import { and, desc, eq, exists, gt, isNull, lt, notExists, or, sql } from 'drizzle-orm'
import { signPayload, verifyPayload } from '../lib/crypto.ts'
import { attachmentDto, attachmentMissing, blobStore, lockStorage } from './attachment-common.ts'
import { enforce, loadAccess } from './authorize.ts'
import { bumpConversation, recordUserChange } from './changes.ts'
import { loadConversation } from './conversation-views.ts'
import type { Deps } from './deps.ts'
import { getMe } from './me.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'
import { retireAttachment } from './uploads.ts'
import { toUserSummary } from './users.ts'

async function permitted(
  db: DbOrTx,
  deps: Deps,
  principal: SessionPrincipal,
  a: typeof attachments.$inferSelect,
): Promise<boolean> {
  if (a.status !== 'ready' || a.deletedAt || a.privacyClass !== 'standard') return false
  if (a.purpose === 'avatar') {
    const [bound] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.avatarAttachmentId, a.id), isNull(users.deletedAt)))
    return !!bound || a.uploaderId === principal.userId
  }
  if (a.purpose === 'conversation_avatar') {
    const [bound] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.avatarAttachmentId, a.id))
    if (!bound) return a.uploaderId === principal.userId
    try {
      const access = await loadAccess(db, principal.userId, bound.id)
      enforce(
        access,
        { userId: principal.userId, siteRole: principal.role },
        'view',
        deps.clock.now(),
      )
      // Site administrators outside a private group do not receive its avatar.
      return bound.kind === 'channel' || access.member !== null
    } catch (error) {
      if (error instanceof AppError && (error.status === 403 || error.status === 404)) return false
      throw error
    }
  }
  if (!a.messageId) return a.uploaderId === principal.userId
  const [message] = await db.select().from(messages).where(eq(messages.id, a.messageId))
  if (!message || message.deletedAt || message.recalledAt) return false
  try {
    const access = await loadAccess(db, principal.userId, message.conversationId)
    enforce(
      access,
      { userId: principal.userId, siteRole: principal.role },
      'read_messages',
      deps.clock.now(),
    )
    if (!access.member || message.seq <= access.member.visibleFromSeq) return false
    const [hidden] = await db
      .select({ id: messageHidden.messageId })
      .from(messageHidden)
      .where(
        and(eq(messageHidden.userId, principal.userId), eq(messageHidden.messageId, message.id)),
      )
    return !hidden
  } catch (error) {
    if (error instanceof AppError && (error.status === 403 || error.status === 404)) return false
    throw error
  }
}
export async function downloadAttachment(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
  variant: 'original' | 'thumb' | 'preview',
) {
  const [a] = await deps.db.select().from(attachments).where(eq(attachments.id, id))
  if (!a || !(await permitted(deps.db, deps, principal, a))) throw attachmentMissing()
  const key = variant === 'original' ? a.storageKey : a.variants[variant]?.key
  if (!key) throw attachmentMissing()
  const [object] = await deps.db
    .select()
    .from(attachmentObjects)
    .where(
      and(
        eq(attachmentObjects.storageKey, key),
        eq(attachmentObjects.status, 'live'),
        eq(attachmentObjects.generation, a.generation),
      ),
    )
  if (!object?.sha256) throw attachmentMissing()
  const stat = await blobStore(deps).stat(key)
  if (!stat || stat.size !== object.sizeBytes) throw attachmentMissing()
  return {
    attachment: a,
    key,
    size: object.sizeBytes,
    etag: `"${object.sha256}"`,
    mime:
      variant === 'original' ? a.mime : (a.variants[variant]?.mime ?? 'application/octet-stream'),
  }
}
export async function listAttachments(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  query: AttachmentQuery,
): Promise<AttachmentPage> {
  const access = await loadAccess(deps.db, principal.userId, conversationId)
  enforce(access, { userId: principal.userId, siteRole: principal.role }, 'view', deps.clock.now())
  enforce(
    access,
    { userId: principal.userId, siteRole: principal.role },
    'read_messages',
    deps.clock.now(),
  )
  const member = access.member
  if (!member) throw new AppError('FORBIDDEN', 'Not a member')
  let position: { seq: number; id: string } | undefined
  if (query.cursor) {
    const raw = verifyPayload(deps.config.auth.cursorKey, query.cursor) as {
      u?: unknown
      c?: unknown
      m?: unknown
      kind?: unknown
      seq?: unknown
      id?: unknown
      x?: unknown
    } | null
    if (
      !raw ||
      raw.u !== principal.userId ||
      raw.c !== conversationId ||
      raw.m !== member.membershipId ||
      raw.kind !== (query.kind ?? null) ||
      typeof raw.seq !== 'number' ||
      typeof raw.id !== 'string' ||
      typeof raw.x !== 'number' ||
      raw.x <= deps.clock.now().getTime()
    )
      throw new AppError('VALIDATION_FAILED', 'Invalid attachment cursor')
    position = { seq: raw.seq, id: raw.id }
  }
  const rows = await deps.db
    .select({ a: attachments, seq: messages.seq, messageId: messages.id })
    .from(attachments)
    .innerJoin(messages, eq(messages.id, attachments.messageId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        gt(messages.seq, member.visibleFromSeq),
        isNull(messages.recalledAt),
        isNull(messages.deletedAt),
        eq(attachments.status, 'ready'),
        eq(attachments.privacyClass, 'standard'),
        query.kind ? eq(attachments.kind, query.kind) : undefined,
        notExists(
          deps.db
            .select({ one: sql`1` })
            .from(messageHidden)
            .where(
              and(
                eq(messageHidden.userId, principal.userId),
                eq(messageHidden.messageId, messages.id),
              ),
            ),
        ),
        position
          ? or(
              lt(messages.seq, position.seq),
              and(eq(messages.seq, position.seq), lt(attachments.id, position.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(messages.seq), desc(attachments.id))
    .limit(query.limit + 1)
  const last = rows[query.limit - 1]
  return {
    items: rows
      .slice(0, query.limit)
      .map((row) => ({ attachment: attachmentDto(row.a), messageId: row.messageId, seq: row.seq })),
    nextCursor:
      rows.length > query.limit && last
        ? signPayload(deps.config.auth.cursorKey, {
            u: principal.userId,
            c: conversationId,
            m: member.membershipId,
            kind: query.kind ?? null,
            seq: last.seq,
            id: last.a.id,
            x: deps.clock.now().getTime() + 600_000,
          })
        : null,
  }
}
export async function setAvatar(
  deps: Deps,
  principal: SessionPrincipal,
  input: SetAvatar,
  conversationId?: string,
) {
  const [head] = conversationId
    ? await deps.db
        .select({ avatarAttachmentId: conversations.avatarAttachmentId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
    : await deps.db
        .select({ avatarAttachmentId: users.avatarAttachmentId })
        .from(users)
        .where(eq(users.id, principal.userId))
  const [old] = head?.avatarAttachmentId
    ? await deps.db
        .select({ uploaderId: attachments.uploaderId })
        .from(attachments)
        .where(eq(attachments.id, head.avatarAttachmentId))
    : []
  await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal, {
      alsoLock: old ? [old.uploaderId] : [],
    })
    let previous = user.avatarAttachmentId
    if (conversationId) {
      const access = await loadAccess(tx, user.id, conversationId, { lock: true })
      enforce(access, { userId: user.id, siteRole: user.role }, 'update', deps.clock.now())
      if (access.conversation.metadataVersion !== input.expectedVersion)
        throw new AppError('VERSION_CONFLICT', 'Conversation changed')
      previous = access.conversation.avatarAttachmentId
    } else if (user.meVersion !== input.expectedVersion)
      throw new AppError('VERSION_CONFLICT', 'Profile changed')
    if (previous !== (head?.avatarAttachmentId ?? null))
      throw new AppError('VERSION_CONFLICT', 'Avatar changed')
    await lockStorage(tx)
    if (input.attachmentId) {
      const [a] = await tx
        .select()
        .from(attachments)
        .where(eq(attachments.id, input.attachmentId))
        .for('update')
      if (
        !a ||
        a.uploaderId !== user.id ||
        a.status !== 'ready' ||
        a.kind !== 'image' ||
        a.messageId ||
        a.purpose !== (conversationId ? 'conversation_avatar' : 'avatar') ||
        a.conversationId !== (conversationId ?? null)
      )
        throw attachmentMissing()
    }
    if (previous === input.attachmentId) return
    if (conversationId) {
      await tx
        .update(conversations)
        .set({ avatarAttachmentId: input.attachmentId })
        .where(eq(conversations.id, conversationId))
      await bumpConversation(tx, deps, conversationId, { metadata: true })
    } else {
      await tx
        .update(users)
        .set({
          avatarAttachmentId: input.attachmentId,
          profileVersion: sql`${users.profileVersion} + 1`,
          meVersion: sql`${users.meVersion} + 1`,
        })
        .where(eq(users.id, user.id))
      await recordUserChange(tx, deps, { userId: user.id, entityType: 'me', entityId: user.id })
    }
    // Both uploader rows were locked in UUID order before the conversation and site counter.
    if (previous) await retireAttachment(tx, deps, previous)
  })
  return conversationId
    ? loadConversation(deps.db, principal.userId, conversationId, deps.clock.now())
    : getMe(deps, principal)
}

/** Candidates are current members and the site bot, regardless of its configured username. */
export async function mentionCandidates(
  deps: Deps,
  principal: SessionPrincipal,
  conversationId: string,
  query: string,
) {
  const access = await loadAccess(deps.db, principal.userId, conversationId)
  enforce(
    access,
    { userId: principal.userId, siteRole: principal.role },
    'read_messages',
    deps.clock.now(),
  )
  const needle = `%${query
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\\%_]/g, '\\$&')}%`
  const rows = await deps.db
    .select()
    .from(users)
    .where(
      and(
        isNull(users.deletedAt),
        eq(users.activationStatus, 'active'),
        or(
          ['group', 'channel'].includes(access.conversation.kind) &&
            access.conversation.settings.agentEnabled !== false
            ? and(eq(users.isBot, true), eq(users.username, deps.config.product.agentUsername))
            : sql`false`,
          exists(
            deps.db
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
        or(
          sql`lower(${users.username}) like ${needle} escape '\\'`,
          sql`lower(${users.name}) like ${needle} escape '\\'`,
        ),
      ),
    )
    .orderBy(users.username)
    .limit(10)
  return { users: rows.map(toUserSummary) }
}
