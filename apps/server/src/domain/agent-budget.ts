import { type AgentUsage, AppError } from '@chatapp/contracts'
import {
  agentRuns,
  aiCallAttempts,
  aiUsageDaily,
  appSettings,
  budgetAccounts,
  type Tx,
  users,
} from '@chatapp/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { type AgentLease, staleLease, withAgentLease } from './agent-access.ts'
import { aiPolicy } from './agent-runs.ts'
import {
  type AiPrice,
  type AiUsage,
  type PaidAttempt,
  type PaidCallLedger,
  reserveCost,
  usageCost,
} from './ai-budget.ts'
import type { Deps } from './deps.ts'
import type { SessionPrincipal } from './principal.ts'
import { lockAndRevalidate, lockUsers } from './sessions.ts'
import { inTransaction } from './tx.ts'

export function budgetPeriod(now: Date, timezone: string): { day: string; month: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const get = (key: string) => parts.find((p) => p.type === key)?.value ?? ''
  const day = `${get('year')}-${get('month')}-${get('day')}`
  return { day, month: day.slice(0, 7) }
}
function nextReset(now: Date, timezone: string, kind: 'day' | 'month'): string {
  const current = budgetPeriod(now, timezone)[kind]
  let low = now.getTime()
  let high = low
  const interval = kind === 'day' ? 3_600_000 : 86_400_000
  do {
    high += interval
  } while (budgetPeriod(new Date(high), timezone)[kind] === current)
  while (high - low > 1000) {
    const mid = Math.floor((high + low) / 2)
    if (budgetPeriod(new Date(mid), timezone)[kind] === current) low = mid
    else high = mid
  }
  return new Date(Math.ceil(high / 1000) * 1000).toISOString()
}
const accountWhere = (scope: 'user_day' | 'site_month', ownerKey: string, period: string) =>
  and(
    eq(budgetAccounts.scope, scope),
    eq(budgetAccounts.ownerKey, ownerKey),
    eq(budgetAccounts.periodStart, period),
  )

async function lockAccounts(
  tx: Tx,
  deps: Deps,
  userId: string,
  period: { day: string; month: string },
): Promise<{ day: typeof budgetAccounts.$inferSelect; month: typeof budgetAccounts.$inferSelect }> {
  const [user] = await tx
    .select({ limit: users.aiDailyTokens })
    .from(users)
    .where(eq(users.id, userId))
  const policy = aiPolicy(deps)
  const specs = [
    {
      scope: 'user_day' as const,
      ownerKey: userId,
      periodStart: period.day,
      limitUnits: user?.limit ?? policy.dailyTokens,
    },
    {
      scope: 'site_month' as const,
      ownerKey: 'site',
      periodStart: period.month,
      limitUnits: policy.siteMicroUsd,
    },
  ]
  const locked: (typeof budgetAccounts.$inferSelect)[] = []
  for (const spec of specs) {
    await tx.insert(budgetAccounts).values(spec).onConflictDoNothing()
    const [row] = await tx
      .select()
      .from(budgetAccounts)
      .where(accountWhere(spec.scope, spec.ownerKey, spec.periodStart))
      .for('update')
    if (!row) throw new Error('budget account missing')
    // Policy changes may lower admission capacity, but never discard prior usage/reservations.
    if (row.limitUnits !== spec.limitUnits)
      await tx
        .update(budgetAccounts)
        .set({ limitUnits: spec.limitUnits })
        .where(accountWhere(spec.scope, spec.ownerKey, spec.periodStart))
    locked.push({ ...row, limitUnits: spec.limitUnits })
  }
  const [day, month] = locked
  if (!day || !month) throw new Error('budget accounts missing')
  return { day, month }
}

/** Async Postgres ledger used by the transport for every request, including every tool-loop step. */
export function createAgentLedger(
  deps: Deps,
  lease: AgentLease,
  stepIndex: number,
  price: AiPrice,
): PaidCallLedger {
  return {
    async reserve(attempt: PaidAttempt) {
      await withAgentLease(deps, lease, async (tx, run) => {
        if (stepIndex >= (run.mode === 'fast' ? 8 : 16))
          throw new AppError('QUOTA_EXCEEDED', 'The step limit was reached')
        const [paused] = await tx
          .select()
          .from(appSettings)
          .where(eq(appSettings.key, 'ai.admission_paused'))
        if (paused?.value === true)
          throw new AppError('AI_BUDGET_EXHAUSTED', 'Model admission is paused')
        const [cooldown] = await tx
          .select()
          .from(appSettings)
          .where(eq(appSettings.key, `ai.provider_cooldown.${run.provider}`))
        if (typeof cooldown?.value === 'number' && cooldown.value > deps.clock.now().getTime())
          throw new AppError('RATE_LIMITED', 'The model service requested a cooldown')
        const period = budgetPeriod(deps.clock.now(), deps.config.timezone)
        const tokens = attempt.inputTokenBound + attempt.maxOutputTokens
        const cost = reserveCost(price, attempt.inputTokenBound, attempt.maxOutputTokens)
        const { day, month } = await lockAccounts(tx, deps, run.userId, period)
        if (day.settledUnits + day.reservedUnits + tokens > day.limitUnits)
          throw new AppError('QUOTA_EXCEEDED', 'The daily model allowance is exhausted')
        if (month.settledUnits + month.reservedUnits + cost > month.limitUnits)
          throw new AppError('AI_BUDGET_EXHAUSTED', 'The site model budget is exhausted')
        const prior = await tx
          .select({ no: aiCallAttempts.attemptNo })
          .from(aiCallAttempts)
          .where(and(eq(aiCallAttempts.runId, run.id), eq(aiCallAttempts.stepIndex, stepIndex)))
        await tx.insert(aiCallAttempts).values({
          id: attempt.id,
          runId: run.id,
          stepIndex,
          attemptNo: prior.length,
          keySource: run.keySource,
          provider: run.provider,
          model: run.model,
          status: 'reserved',
          ...period,
          priceVersion: price.version,
          inputTokenBound: attempt.inputTokenBound,
          maxOutputTokens: attempt.maxOutputTokens,
          reservedTokens: tokens,
          reservedCost: cost,
          createdAt: deps.clock.now(),
        })
        await tx
          .update(budgetAccounts)
          .set({ reservedUnits: sql`${budgetAccounts.reservedUnits} + ${tokens}` })
          .where(accountWhere('user_day', run.userId, period.day))
        await tx
          .update(budgetAccounts)
          .set({ reservedUnits: sql`${budgetAccounts.reservedUnits} + ${cost}` })
          .where(accountWhere('site_month', 'site', period.month))
      })
    },
    async start(id: string) {
      await withAgentLease(deps, lease, async (tx, run) => {
        const changed = await tx
          .update(aiCallAttempts)
          .set({ status: 'started', startedAt: deps.clock.now() })
          .where(
            and(
              eq(aiCallAttempts.id, id),
              eq(aiCallAttempts.runId, run.id),
              eq(aiCallAttempts.status, 'reserved'),
            ),
          )
          .returning({ id: aiCallAttempts.id })
        if (changed.length !== 1) throw staleLease()
      })
    },
    async settle(id: string, usage: AiUsage) {
      await resolveAttempt(deps, id, lease.id, { status: 'settled', usage, price })
    },
    async unknown(id: string) {
      await resolveAttempt(deps, id, lease.id, { status: 'unknown' })
    },
    async release(id: string) {
      await resolveAttempt(deps, id, lease.id, { status: 'released' })
    },
  }
}

/** Settlement outlives cancellation, origin revocation and midnight. Locks the original accounts and CAS settles once. */
export async function resolveAttempt(
  deps: Deps,
  id: string,
  runId: string,
  resolution: {
    status: 'unknown' | 'released' | 'settled'
    usage?: AiUsage
    price?: AiPrice
    expectedStatus?: 'reserved' | 'started'
  },
): Promise<void> {
  const [reference] = await deps.db
    .select({ userId: agentRuns.userId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
  if (!reference) return
  await inTransaction(deps.db, async (tx) => {
    await lockUsers(tx, [reference.userId])
    const [attempt] = await tx
      .select()
      .from(aiCallAttempts)
      .where(and(eq(aiCallAttempts.id, id), eq(aiCallAttempts.runId, runId)))
      .for('update')
    if (!attempt || ['settled', 'released'].includes(attempt.status)) return
    if (resolution.expectedStatus && attempt.status !== resolution.expectedStatus) return
    if (resolution.status === 'unknown') {
      if (attempt.status === 'started')
        await tx.update(aiCallAttempts).set({ status: 'unknown' }).where(eq(aiCallAttempts.id, id))
      return
    }
    if (resolution.status === 'released' && attempt.status === 'unknown') return
    if (
      resolution.status === 'settled' &&
      (!resolution.usage || !resolution.price || resolution.price.version !== attempt.priceVersion)
    )
      throw new Error('invalid settlement')
    const cost =
      resolution.status === 'settled' && resolution.price && resolution.usage
        ? usageCost(resolution.price, resolution.usage)
        : 0
    const tokens = resolution.usage
      ? resolution.usage.inputTokens + resolution.usage.outputTokens
      : 0
    await tx
      .select()
      .from(budgetAccounts)
      .where(accountWhere('user_day', reference.userId, attempt.day))
      .for('update')
    await tx
      .select()
      .from(budgetAccounts)
      .where(accountWhere('site_month', 'site', attempt.month))
      .for('update')
    await tx
      .update(budgetAccounts)
      .set({
        reservedUnits: sql`${budgetAccounts.reservedUnits} - ${attempt.reservedTokens}`,
        settledUnits: sql`${budgetAccounts.settledUnits} + ${tokens}`,
      })
      .where(accountWhere('user_day', reference.userId, attempt.day))
    await tx
      .update(budgetAccounts)
      .set({
        reservedUnits: sql`${budgetAccounts.reservedUnits} - ${attempt.reservedCost}`,
        settledUnits: sql`${budgetAccounts.settledUnits} + ${cost}`,
      })
      .where(accountWhere('site_month', 'site', attempt.month))
    await tx
      .update(aiCallAttempts)
      .set({
        status: resolution.status,
        actualTokens: tokens,
        actualCost: cost,
        inputTokens: resolution.usage?.inputTokens,
        outputTokens: resolution.usage?.outputTokens,
        cachedTokens: resolution.usage?.cachedTokens,
        reasoningTokens: resolution.usage?.reasoningTokens,
        settledAt: deps.clock.now(),
      })
      .where(eq(aiCallAttempts.id, id))
    if (resolution.status === 'settled' && resolution.usage) {
      const usage = resolution.usage
      await tx
        .update(agentRuns)
        .set({
          inputTokens: sql`${agentRuns.inputTokens} + ${usage.inputTokens}`,
          outputTokens: sql`${agentRuns.outputTokens} + ${usage.outputTokens}`,
          cachedTokens: sql`${agentRuns.cachedTokens} + ${usage.cachedTokens}`,
          costMicroUsd: sql`${agentRuns.costMicroUsd} + ${cost}`,
        })
        .where(eq(agentRuns.id, runId))
      await tx
        .insert(aiUsageDaily)
        .values({
          userId: reference.userId,
          day: attempt.day,
          keySource: attempt.keySource,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedTokens: usage.cachedTokens,
          costMicroUsd: cost,
          runCount: attempt.stepIndex === 0 ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: [aiUsageDaily.userId, aiUsageDaily.day, aiUsageDaily.keySource],
          set: {
            inputTokens: sql`${aiUsageDaily.inputTokens} + ${usage.inputTokens}`,
            outputTokens: sql`${aiUsageDaily.outputTokens} + ${usage.outputTokens}`,
            cachedTokens: sql`${aiUsageDaily.cachedTokens} + ${usage.cachedTokens}`,
            costMicroUsd: sql`${aiUsageDaily.costMicroUsd} + ${cost}`,
            runCount: sql`${aiUsageDaily.runCount} + ${attempt.stepIndex === 0 ? 1 : 0}`,
          },
        })
      if (
        tokens > attempt.reservedTokens ||
        cost > attempt.reservedCost ||
        usage.inputTokens > attempt.inputTokenBound ||
        usage.outputTokens > attempt.maxOutputTokens
      ) {
        await tx
          .insert(appSettings)
          .values({ key: 'ai.admission_paused', value: true })
          .onConflictDoUpdate({ target: appSettings.key, set: { value: true } })
        deps.log.error('ai.bound_exceeded', { runId })
      }
    }
  })
}

/** A retiring executor may only close its own attempts. Late confirmed usage can still settle unknown. */
export async function closeAgentCalls(
  deps: Deps,
  runId: string,
  ids: string[],
): Promise<{ id: string; status: 'unknown' | 'released' }[]> {
  if (!ids.length) return []
  const own = and(eq(aiCallAttempts.runId, runId), inArray(aiCallAttempts.id, ids))
  const pending = await deps.db
    .select()
    .from(aiCallAttempts)
    .where(and(own, inArray(aiCallAttempts.status, ['reserved', 'started'])))
  for (const attempt of pending) {
    const status = attempt.status as 'reserved' | 'started'
    await resolveAttempt(deps, attempt.id, runId, {
      status: status === 'reserved' ? 'released' : 'unknown',
      expectedStatus: status,
    })
  }
  const closed = await deps.db
    .select({ id: aiCallAttempts.id, status: aiCallAttempts.status })
    .from(aiCallAttempts)
    .where(and(own, inArray(aiCallAttempts.status, ['unknown', 'released'])))
  return closed.map((a) => ({ id: a.id, status: a.status as 'unknown' | 'released' }))
}

export async function getAgentUsage(deps: Deps, principal: SessionPrincipal): Promise<AgentUsage> {
  return await deps.db.transaction(async (tx) => {
    await lockAndRevalidate(tx, deps, principal)
    const period = budgetPeriod(deps.clock.now(), deps.config.timezone)
    const { day, month } = await lockAccounts(tx, deps, principal.userId, period)
    const unknown = await tx
      .select({
        tokens: aiCallAttempts.reservedTokens,
        cost: aiCallAttempts.reservedCost,
        userId: agentRuns.userId,
        day: aiCallAttempts.day,
        month: aiCallAttempts.month,
      })
      .from(aiCallAttempts)
      .innerJoin(agentRuns, eq(agentRuns.id, aiCallAttempts.runId))
      .where(
        and(
          eq(aiCallAttempts.status, 'unknown'),
          sql`(${aiCallAttempts.day} = ${period.day} or ${aiCallAttempts.month} = ${period.month})`,
        ),
      )
    const unknownTokens = unknown
      .filter((a) => a.userId === principal.userId && a.day === period.day)
      .reduce((n, a) => n + a.tokens, 0)
    const unknownCost = unknown
      .filter((a) => a.month === period.month)
      .reduce((n, a) => n + a.cost, 0)
    const [paused] = await tx
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, 'ai.admission_paused'))
    return {
      provider: aiPolicy(deps).provider,
      ...period,
      daily: {
        limit: day.limitUnits,
        settled: day.settledUnits,
        reserved: day.reservedUnits - unknownTokens,
        unknown: unknownTokens,
        available: Math.max(0, day.limitUnits - day.settledUnits - day.reservedUnits),
        resetAt: nextReset(deps.clock.now(), deps.config.timezone, 'day'),
      },
      monthly: {
        limitMicroUsd: month.limitUnits,
        settledMicroUsd: month.settledUnits,
        reservedMicroUsd: month.reservedUnits - unknownCost,
        unknownMicroUsd: unknownCost,
        availableMicroUsd: Math.max(0, month.limitUnits - month.settledUnits - month.reservedUnits),
        resetAt: nextReset(deps.clock.now(), deps.config.timezone, 'month'),
      },
      warning:
        day.settledUnits + day.reservedUnits >= day.limitUnits * 0.8 ||
        (month.limitUnits > 0 &&
          month.settledUnits + month.reservedUnits >= month.limitUnits * 0.8),
      paused: paused?.value === true,
    }
  })
}

/** Provider identifiers are whitelisted audit fields; neither prompts nor response bodies belong here. */
export async function recordAgentEvidence(
  deps: Deps,
  evidence: {
    attemptId: string
    actualModel?: string | null
    responseId?: string | null
    httpStatus?: number
    retryAfterSeconds?: number
  },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [attempt] = await tx
      .update(aiCallAttempts)
      .set({
        actualModel: evidence.actualModel,
        providerRequestId: evidence.responseId,
        httpStatus: evidence.httpStatus,
        retryAfterSeconds: evidence.retryAfterSeconds,
      })
      .where(eq(aiCallAttempts.id, evidence.attemptId))
      .returning({ runId: aiCallAttempts.runId, provider: aiCallAttempts.provider })
    if (attempt && evidence.httpStatus === 429) {
      const seconds = Math.max(1, Math.min(86_400, evidence.retryAfterSeconds ?? 60))
      const key = `ai.provider_cooldown.${attempt.provider}`
      const until = deps.clock.now().getTime() + seconds * 1000
      await tx
        .insert(appSettings)
        .values({ key, value: until })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: {
            value: sql`to_jsonb(greatest((${appSettings.value} #>> '{}')::bigint, ${until}::bigint))`,
          },
        })
    }
    if (attempt && evidence.actualModel)
      await tx
        .update(agentRuns)
        .set({ actualModel: evidence.actualModel })
        .where(eq(agentRuns.id, attempt.runId))
  })
}
