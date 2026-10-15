import {
  AppError,
  markdownPreviewText,
  mentionIds,
  plainMessageText,
  type reportRequestSchema,
  type reportUpdateSchema,
} from '@chatapp/contracts'
import { messageHidden, messages, reports, users } from '@chatapp/db'
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { fingerprint } from '../lib/crypto.ts'
import { writeAudit } from './audit.ts'
import { enforce, loadAccess } from './authorize.ts'
import type { Deps } from './deps.ts'
import { assertIdempotencyKey, claimIdempotency, completeIdempotency } from './idempotency.ts'
import { notifyAdmins } from './notifications.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate } from './sessions.ts'
import { requireSiteAdmin } from './site-admin.ts'
import { inTransaction } from './tx.ts'

export async function submitReport(
  deps: Deps,
  principal: SessionPrincipal,
  input: z.infer<typeof reportRequestSchema>,
  key: string,
) {
  assertIdempotencyKey(key)
  const result = await inTransaction(deps.db, async (tx) => {
    const user = await lockAndRevalidate(tx, deps, principal)
    const missing = () => new AppError('NOT_FOUND', 'Message not found')
    const [row] = await tx.select().from(messages).where(eq(messages.id, input.messageId))
    if (!row) throw missing()
    let access: Awaited<ReturnType<typeof loadAccess>>
    try {
      access = await loadAccess(tx, principal.userId, row.conversationId, { lock: true })
      enforce(
        access,
        { userId: principal.userId, siteRole: user.role },
        'read_messages',
        deps.clock.now(),
      )
    } catch (error) {
      if (error instanceof AppError && [403, 404].includes(error.status)) throw missing()
      throw error
    }
    const [hidden] = await tx
      .select({ id: messageHidden.messageId })
      .from(messageHidden)
      .where(and(eq(messageHidden.userId, principal.userId), eq(messageHidden.messageId, row.id)))
    if (
      !access.member ||
      row.seq <= access.member.visibleFromSeq ||
      hidden ||
      row.deletedAt ||
      row.recalledAt
    )
      throw missing()
    const claim = await claimIdempotency(
      tx,
      deps,
      { actorKey: principal.userId, operation: 'report.create', targetKey: row.id, key },
      fingerprint(input),
    )
    if (claim.status === 'replay') {
      if (!claim.resourceId) throw new Error('report receipt missing')
      return { reportId: claim.resourceId, new: false }
    }
    const [existing] = await tx
      .select({ id: reports.id })
      .from(reports)
      .where(and(eq(reports.messageId, row.id), eq(reports.reporterId, principal.userId)))
    const [created] = existing
      ? []
      : await tx
          .insert(reports)
          .values({
            messageId: row.id,
            conversationId: row.conversationId,
            reporterId: principal.userId,
            visibleFromSeq: access.member.visibleFromSeq,
            reason: input.reason,
            details: input.details || null,
          })
          .returning({ id: reports.id })
    const id = existing?.id ?? created?.id
    if (!id) throw new Error('report was not created')
    await completeIdempotency(tx, claim.id, { type: 'report', id })
    return { reportId: id, new: !existing }
  })
  if (result.new)
    await notifyAdmins(deps, {
      type: 'report_opened',
      dedupeKey: `report:${result.reportId}`,
      data: { reportId: result.reportId },
    })
  return { reportId: result.reportId }
}

export async function viewReportContext(deps: Deps, principal: SessionPrincipal, id: string) {
  return await inTransaction(deps.db, async (tx) => {
    await requireSiteAdmin(tx, deps, principal)
    const [report] = await tx.select().from(reports).where(eq(reports.id, id)).for('update')
    if (!report) throw new AppError('NOT_FOUND', 'Report not found')
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'report.context.view',
      targetType: 'report',
      targetId: id,
    })
    const [reported] = report.messageId
      ? await tx.select().from(messages).where(eq(messages.id, report.messageId))
      : []
    if (
      !reported ||
      reported.deletedAt ||
      reported.recalledAt ||
      !reported.conversationId ||
      reported.seq <= report.visibleFromSeq
    )
      return { available: false, messages: [] }
    const rows = await tx
      .select({ row: messages, name: users.name })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          eq(messages.conversationId, reported.conversationId),
          gt(messages.seq, report.visibleFromSeq),
          sql`${messages.seq} between ${reported.seq - 5} and ${reported.seq + 5}`,
        ),
      )
      .orderBy(asc(messages.seq))
      .limit(11)
    const mentioned = [
      ...new Set(
        rows.flatMap(({ row }) =>
          !row.deletedAt && !row.recalledAt && row.body ? mentionIds(row.body) : [],
        ),
      ),
    ]
    const names = new Map(
      (mentioned.length
        ? await tx
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, mentioned))
        : []
      ).map((row) => [row.id, row.name]),
    )
    return {
      available: true,
      messages: rows.map(({ row, name }) => ({
        id: row.id,
        senderName: name ?? '',
        body:
          row.deletedAt || row.recalledAt
            ? null
            : plainMessageText(markdownPreviewText(row.body ?? ''), (id) => names.get(id)),
        createdAt: row.createdAt.toISOString(),
        reported: row.id === reported.id,
        unavailable: !!row.deletedAt || !!row.recalledAt,
      })),
    }
  })
}
export async function decideReport(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
  input: z.infer<typeof reportUpdateSchema>,
  key: string,
) {
  assertIdempotencyKey(key)
  await inTransaction(deps.db, async (tx) => {
    await requireSiteAdmin(tx, deps, principal)
    const [row] = await tx.select().from(reports).where(eq(reports.id, id)).for('update')
    if (!row) throw new AppError('NOT_FOUND', 'Report not found')
    const claim = await claimIdempotency(
      tx,
      deps,
      { actorKey: principal.userId, operation: 'report.decide', targetKey: id, key },
      fingerprint(input),
    )
    if (claim.status === 'replay') return
    if (row.version !== input.expectedVersion)
      throw new AppError('CONFLICT', 'The report changed; refresh before trying again')
    await tx
      .update(reports)
      .set({
        status: input.status,
        resolutionNote: input.resolutionNote || null,
        handledBy: principal.userId,
        handledAt: deps.clock.now(),
        version: row.version + 1,
      })
      .where(eq(reports.id, id))
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'report.handled',
      targetType: 'report',
      targetId: id,
      metadata: { status: input.status },
    })
    await completeIdempotency(tx, claim.id, { type: 'report', id })
  })
}
