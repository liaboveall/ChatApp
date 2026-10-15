import { clientSiteLimitsSchema, type SitePolicy, sitePolicySchema } from '@chatapp/contracts'
import { appSettings, type DbOrTx } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { loadAiConfig } from '../config/ai.ts'
import type { Deps } from './deps.ts'

export const SITE_POLICY_KEY = 'site.policy'
export async function readSitePolicy(
  deps: Pick<Deps, 'config'>,
  db: DbOrTx,
): Promise<{ policy: SitePolicy; version: number }> {
  const ai = deps.config.ai ?? loadAiConfig({ APP_ENV: 'test' })
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SITE_POLICY_KEY))
  return {
    version: row?.version ?? 1,
    policy: row
      ? sitePolicySchema.parse(row.value)
      : sitePolicySchema.parse({
          runContentDays: 30,
          userDailyTokens: ai.dailyTokens,
          monthlyMicroUsd: ai.siteMicroUsd,
          aiPaused: false,
        }),
  }
}

export async function readSiteLimits(deps: Pick<Deps, 'config'>, db: DbOrTx) {
  return (await readSitePolicy(deps, db)).policy.limits
}
export async function readClientSiteLimits(deps: Pick<Deps, 'config'>, db: DbOrTx) {
  const { messageRecallWindowMs, messageEditWindowMs, fileBytes, imageBytes } =
    await readSiteLimits(deps, db)
  return clientSiteLimitsSchema.parse({
    messageRecallWindowMs,
    messageEditWindowMs,
    fileBytes,
    imageBytes,
  })
}
export async function readAgentLimits(
  deps: Pick<Deps, 'config'>,
  db: DbOrTx,
  mode: 'fast' | 'deep',
) {
  const limits = await readSiteLimits(deps, db)
  return mode === 'fast'
    ? { steps: limits.fastSteps, durationMs: limits.fastDurationMs }
    : { steps: limits.deepSteps, durationMs: limits.deepDurationMs }
}
