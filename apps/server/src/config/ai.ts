import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AiPrice } from '../domain/ai-budget.ts'
import { usdToMicro } from '../domain/ai-budget.ts'
import { ConfigError } from './env.ts'

export const AI_LIMITS = {
  fast: { steps: 8, durationMs: 120_000, maxOutputTokens: 4096, maxInputTokens: 32_768 },
  deep: { steps: 16, durationMs: 300_000, maxOutputTokens: 16_384, maxInputTokens: 131_072 },
} as const
export type AiMode = keyof typeof AI_LIMITS
export type AiProvider = 'deepseek' | 'soclaas' | 'mock'
export type AiConfig = {
  provider: AiProvider
  apiKey: string | undefined
  models: Record<AiMode, string>
  prices: Record<AiMode, AiPrice>
  dailyTokens: number
  monthlyMicroUsd: number
  experimentMicroUsd: number
  /** The experiment reservation is subtracted, so two environments cannot each spend the same $20. */
  siteMicroUsd: number
  /**
   * Members' own keys (M5a): always DeepSeek at its fixed endpoint, with its own model names and prices, never the site
   * provider's alias (docs/06 section 6). The test environment uses the mock model for them too.
   */
  byok: {
    provider: 'deepseek' | 'mock'
    models: Record<AiMode, string>
    prices: Record<AiMode, AiPrice>
  }
}

const money = z.string().regex(/^(0|[1-9]\d*)(?:\.\d{1,6})?$/)
const model = z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/)
const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AI_PROVIDER: z.enum(['deepseek', 'soclaas', 'mock']).optional(),
  DEEPSEEK_API_KEY: z.string().optional(),
  SOCLAAS_API_KEY: z.string().optional(),
  AI_MODEL_FAST: model.optional(),
  AI_MODEL_DEEP: model.optional(),
  AI_BYOK_MODEL_FAST: model.default('deepseek-flash'),
  AI_BYOK_MODEL_DEEP: model.default('deepseek-flash'),
  AI_USER_DAILY_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(500_000),
  AI_MONTHLY_BUDGET_USD: money.default('20'),
  AI_EXPERIMENT_BUDGET_USD: money.default('0'),
  AI_PRICE_FAST_INPUT_CACHE_HIT: money.default('0.006'),
  AI_PRICE_FAST_INPUT: money.default('0.3'),
  AI_PRICE_FAST_OUTPUT: money.default('1.2'),
  AI_PRICE_DEEP_INPUT_CACHE_HIT: money.default('0.006'),
  AI_PRICE_DEEP_INPUT: money.default('0.3'),
  AI_PRICE_DEEP_OUTPUT: money.default('1.2'),
})

export function loadAiConfig(
  source: Record<string, string | undefined>,
  options: { requireKey?: boolean } = {},
): AiConfig {
  const parsed = schema.safeParse(source)
  if (!parsed.success)
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: invalid AI configuration`),
    )
  const raw = parsed.data
  const provider = raw.AI_PROVIDER ?? (raw.APP_ENV === 'test' ? 'mock' : 'soclaas')
  if (raw.APP_ENV === 'test' && provider !== 'mock')
    throw new ConfigError(['AI_PROVIDER: tests must use mock'])
  if (raw.APP_ENV !== 'test' && provider === 'mock')
    throw new ConfigError(['AI_PROVIDER: mock is restricted to the test environment'])
  const keyName = provider === 'soclaas' ? 'SOCLAAS_API_KEY' : 'DEEPSEEK_API_KEY'
  const apiKey = raw[keyName]?.trim() || undefined
  if (provider !== 'mock' && !apiKey && options.requireKey !== false)
    throw new ConfigError([`${keyName}: required for ${provider}`])
  const defaultModel = provider === 'soclaas' ? 'x-test-1' : 'deepseek-flash'
  const models = {
    fast: raw.AI_MODEL_FAST ?? defaultModel,
    deep: raw.AI_MODEL_DEEP ?? defaultModel,
  }
  const amount = (name: keyof typeof raw): number => {
    try {
      return usdToMicro(String(raw[name]))
    } catch {
      throw new ConfigError([`${name}: invalid amount`])
    }
  }
  const monthlyMicroUsd = amount('AI_MONTHLY_BUDGET_USD')
  const experimentMicroUsd = amount('AI_EXPERIMENT_BUDGET_USD')
  if (experimentMicroUsd > monthlyMicroUsd)
    throw new ConfigError(['AI_EXPERIMENT_BUDGET_USD: exceeds total monthly budget'])
  const byokProvider = provider === 'mock' ? ('mock' as const) : ('deepseek' as const)
  const byokModels = {
    fast: provider === 'mock' ? 'mock-byok' : raw.AI_BYOK_MODEL_FAST,
    deep: provider === 'mock' ? 'mock-byok' : raw.AI_BYOK_MODEL_DEEP,
  }
  const byokPrices = {} as Record<AiMode, AiPrice>
  for (const mode of ['fast', 'deep'] as const) {
    const prefix = mode === 'fast' ? 'FAST' : 'DEEP'
    const rates = {
      input: amount(`AI_PRICE_${prefix}_INPUT`),
      cachedInput: amount(`AI_PRICE_${prefix}_INPUT_CACHE_HIT`),
      output: amount(`AI_PRICE_${prefix}_OUTPUT`),
    }
    byokPrices[mode] = {
      ...rates,
      version: createHash('sha256')
        .update(
          JSON.stringify({ provider: byokProvider, model: byokModels[mode], ...rates, byok: true }),
        )
        .digest('hex')
        .slice(0, 16),
    }
  }
  const prices = {} as Record<AiMode, AiPrice>
  for (const mode of ['fast', 'deep'] as const) {
    const prefix = mode === 'fast' ? 'FAST' : 'DEEP'
    const rates =
      provider === 'soclaas'
        ? { input: 0, cachedInput: 0, output: 0 }
        : {
            input: amount(`AI_PRICE_${prefix}_INPUT`),
            cachedInput: amount(`AI_PRICE_${prefix}_INPUT_CACHE_HIT`),
            output: amount(`AI_PRICE_${prefix}_OUTPUT`),
          }
    if (rates.cachedInput > rates.input)
      throw new ConfigError([`AI_PRICE_${prefix}_INPUT_CACHE_HIT: exceeds input price`])
    prices[mode] = {
      ...rates,
      version: createHash('sha256')
        .update(JSON.stringify({ provider, model: models[mode], ...rates }))
        .digest('hex')
        .slice(0, 16),
    }
  }
  return {
    provider,
    apiKey: provider === 'mock' ? undefined : apiKey,
    models,
    prices,
    dailyTokens: raw.AI_USER_DAILY_TOKENS,
    monthlyMicroUsd,
    experimentMicroUsd,
    siteMicroUsd: monthlyMicroUsd - experimentMicroUsd,
    byok: { provider: byokProvider, models: byokModels, prices: byokPrices },
  }
}
