import { average } from './metrics.ts'

export type CapacitySample = {
  durationMs: number
  tokens: number
  costMicroUsd: number
  unknownTokens: number
  unknownCostMicroUsd: number
}
const percentile = (values: number[], fraction: number) => {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0
}
/** Explicit planning assumptions on the measured task mix; this is not a guaranteed service allocation. */
export function capacityProjection(
  samples: CapacitySample[],
  dailyTokens: number,
  siteMicroUsd: number,
) {
  const meanTokens = average(samples.map((s) => s.tokens + s.unknownTokens))
  const meanCost = average(samples.map((s) => s.costMicroUsd + s.unknownCostMicroUsd))
  return {
    sampleTasks: samples.length,
    meanTokens,
    meanCostMicroUsd: meanCost,
    tokensP50: percentile(
      samples.map((s) => s.tokens + s.unknownTokens),
      0.5,
    ),
    tokensP95: percentile(
      samples.map((s) => s.tokens + s.unknownTokens),
      0.95,
    ),
    durationMsP50: percentile(
      samples.map((s) => s.durationMs),
      0.5,
    ),
    durationMsP95: percentile(
      samples.map((s) => s.durationMs),
      0.95,
    ),
    costMicroUsdP50: percentile(
      samples.map((s) => s.costMicroUsd + s.unknownCostMicroUsd),
      0.5,
    ),
    costMicroUsdP95: percentile(
      samples.map((s) => s.costMicroUsd + s.unknownCostMicroUsd),
      0.95,
    ),
    currencyBudgetTasksEstimate: meanCost > 0 ? Math.floor(siteMicroUsd / meanCost) : null,
    perUserDailyTasksEstimate: meanTokens > 0 ? Math.floor(dailyTokens / meanTokens) : null,
    scenarios: [
      { name: 'low', activeUsers: 10, tasksPerDay: 1 },
      { name: 'base', activeUsers: 50, tasksPerDay: 3 },
      { name: 'high', activeUsers: 100, tasksPerDay: 5 },
    ].map((scenario) => {
      const monthlyTasks = scenario.activeUsers * scenario.tasksPerDay * 30
      return {
        ...scenario,
        days: 30,
        monthlyTasks,
        estimatedTokens: Math.ceil(monthlyTasks * meanTokens),
        estimatedMicroUsd: Math.ceil(monthlyTasks * meanCost),
        currencyBudgetDaysEstimate:
          meanCost > 0
            ? siteMicroUsd / (scenario.activeUsers * scenario.tasksPerDay * meanCost)
            : null,
      }
    }),
    note: 'Task mix, AI-active users and daily task counts are assumptions. Includes measured retries and unknown reservations. Daily admission also reserves full input/output bounds. Free service has no currency-derived task or exhaustion limit; provider quotas, concurrent capacity and production load remain separate measurements.',
  }
}
