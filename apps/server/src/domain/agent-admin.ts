/**
 * What a site administrator may see of assistant runs (docs/05 section 3.7, D-034, INV-15, A7). Metadata of every run;
 * the content (history, tool steps, approval arguments) only of site-key runs inside the 30-day retention. Runs on a
 * member's own key never show content to anyone but their owner. Every detail view is written to the audit log.
 */
import {
  type AdminAgentRunDetail,
  type AdminAgentRunQuery,
  type AgentRun,
  AppError,
} from '@chatapp/contracts'
import { agentRunStates, agentRuns, agentSteps } from '@chatapp/db'
import { and, asc, desc, eq, lt, or } from 'drizzle-orm'
import { runDecisions } from './agent-approvals.ts'
import { agentRunDto } from './agent-runs.ts'
import { writeAudit } from './audit.ts'
import { cursorExpiry, decodeCursor, encodeCursor } from './cursor.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate } from './sessions.ts'
import { inTransaction } from './tx.ts'

async function requireSiteAdmin(
  tx: import('@chatapp/db').Tx,
  deps: Deps,
  principal: SessionPrincipal,
): Promise<void> {
  const user = await lockAndRevalidate(tx, deps, principal)
  if (user.role !== 'admin')
    throw new AppError('FORBIDDEN', 'Only site administrators can view assistant runs')
}

export async function listAdminRuns(
  deps: Deps,
  principal: SessionPrincipal,
  query: AdminAgentRunQuery,
): Promise<{ runs: AgentRun[]; nextCursor: string | null }> {
  return await inTransaction(deps.db, async (tx) => {
    await requireSiteAdmin(tx, deps, principal)
    const filters = JSON.stringify([
      query.userId ?? null,
      query.keySource ?? null,
      query.status ?? null,
    ])
    const cursor = query.cursor ? decodeCursor(deps, query.cursor, 'admin-runs', principal) : null
    if (query.cursor && (!cursor || cursor.f !== filters))
      throw new AppError('VALIDATION_FAILED', 'The cursor does not belong to this list', {
        details: { field: 'cursor' },
      })
    const rows = await tx
      .select()
      .from(agentRuns)
      .where(
        and(
          query.userId ? eq(agentRuns.userId, query.userId) : undefined,
          query.keySource ? eq(agentRuns.keySource, query.keySource) : undefined,
          query.status ? eq(agentRuns.status, query.status) : undefined,
          cursor
            ? or(
                lt(agentRuns.createdAt, new Date(cursor.o[0])),
                and(eq(agentRuns.createdAt, new Date(cursor.o[0])), lt(agentRuns.id, cursor.o[1])),
              )
            : undefined,
        ),
      )
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(query.limit + 1)
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return {
      runs: page.map(agentRunDto),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor(deps, {
              k: 'admin-runs',
              u: principal.userId,
              f: filters,
              o: [last.createdAt.toISOString(), last.id],
              x: cursorExpiry(deps),
            })
          : null,
    }
  })
}

export async function adminRunDetail(
  deps: Deps,
  principal: SessionPrincipal,
  id: string,
): Promise<AdminAgentRunDetail> {
  return await inTransaction(deps.db, async (tx) => {
    await requireSiteAdmin(tx, deps, principal)
    const [run] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id))
    if (!run) throw new AppError('NOT_FOUND', 'Run not found')
    const available =
      run.keySource !== 'site' ? 'own_key' : run.contentPurgedAt ? 'purged' : 'site_key'
    await writeAudit(tx, {
      actorId: principal.userId,
      action: 'admin.agent_run_viewed',
      targetType: 'agent_run',
      targetId: run.id,
      metadata: { keySource: run.keySource, content: available },
    })
    if (available !== 'site_key') return { run: agentRunDto(run), content: { available } }
    const [state] = await tx.select().from(agentRunStates).where(eq(agentRunStates.runId, run.id))
    const steps = await tx
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, run.id))
      .orderBy(asc(agentSteps.index))
    const decisions = await runDecisions(tx, deps, run)
    return {
      run: agentRunDto(run),
      content: {
        available,
        history: state?.messages ?? [],
        approvals: decisions.approvals,
        steps: steps.map((step) => ({
          index: step.index,
          type: step.type,
          toolName: step.toolName,
          status: step.status,
          payload: step.payload,
          createdAt: step.createdAt.toISOString(),
        })),
      },
    }
  })
}
