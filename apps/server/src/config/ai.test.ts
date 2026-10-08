import { describe, expect, test } from 'bun:test'
import { AI_LIMITS, loadAiConfig } from './ai.ts'

const mockConfig = (source: Record<string, string> = {}) =>
  loadAiConfig({ APP_ENV: 'test', AI_PROVIDER: 'mock', ...source })

describe('AI configuration', () => {
  test('tests select mock and discard even an ambient real key', () => {
    expect(
      loadAiConfig({ APP_ENV: 'test', DEEPSEEK_API_KEY: 'fixture-do-not-send' }).apiKey,
    ).toBeUndefined()
    expect(loadAiConfig({ APP_ENV: 'test' }).provider).toBe('mock')
    expect(() =>
      loadAiConfig({
        APP_ENV: 'test',
        AI_PROVIDER: 'deepseek',
        DEEPSEEK_API_KEY: 'fixture-do-not-send',
      }),
    ).toThrow('tests must use mock')
  })
  test('real provider requires an explicit key; mock does not', () => {
    expect(() => loadAiConfig({})).toThrow('SOCLAAS_API_KEY')
    expect(mockConfig().provider).toBe('mock')
    expect(() => loadAiConfig({ AI_PROVIDER: 'mock' })).toThrow('restricted to the test')
  })
  test('SoCLaaS selects only its own key and the trial model, with zero-cost accounting', () => {
    const config = loadAiConfig({
      AI_PROVIDER: 'soclaas',
      SOCLAAS_API_KEY: 'school-fixture',
      DEEPSEEK_API_KEY: 'paid-fixture',
    })
    expect(config.apiKey).toBe('school-fixture')
    expect(config.models).toEqual({ fast: 'x-test-1', deep: 'x-test-1' })
    expect(config.prices.fast).toMatchObject({ input: 0, cachedInput: 0, output: 0 })
    expect(config.dailyTokens).toBe(500_000)
    expect(() =>
      loadAiConfig({ AI_PROVIDER: 'soclaas', DEEPSEEK_API_KEY: 'paid-fixture' }),
    ).toThrow('SOCLAAS_API_KEY')
  })
  test('experiment allowance is subtracted from the single monthly budget', () => {
    const config = mockConfig({ AI_EXPERIMENT_BUDGET_USD: '5' })
    expect(config.monthlyMicroUsd).toBe(20_000_000)
    expect(config.experimentMicroUsd).toBe(5_000_000)
    expect(config.siteMicroUsd).toBe(15_000_000)
    expect(() => mockConfig({ AI_EXPERIMENT_BUDGET_USD: '21' })).toThrow('exceeds')
  })
  test('price versions change when the rates or model change', () => {
    const base = mockConfig()
    expect(base.prices.fast).toMatchObject({ input: 300_000, cachedInput: 6000, output: 1_200_000 })
    expect(mockConfig({ AI_PRICE_FAST_OUTPUT: '1.21' }).prices.fast.version).not.toBe(
      base.prices.fast.version,
    )
    expect(mockConfig({ AI_MODEL_FAST: 'different-model' }).prices.fast.version).not.toBe(
      base.prices.fast.version,
    )
  })
  test('invalid config errors never echo credential or attacker-controlled values', () => {
    const sentinel = 'private-fixture-value'
    try {
      loadAiConfig({
        DEEPSEEK_API_KEY: sentinel,
        AI_MODEL_FAST: `https://${sentinel}`,
        AI_MONTHLY_BUDGET_USD: sentinel,
      })
    } catch (error) {
      expect(String(error)).toContain('AI_MODEL_FAST')
      expect(String(error)).not.toContain(sentinel)
    }
  })
  test('the quick and deep resource limits match the agreed specification', () => {
    expect(AI_LIMITS.fast).toMatchObject({ steps: 8, durationMs: 120_000, maxOutputTokens: 4096 })
    expect(AI_LIMITS.deep).toMatchObject({
      steps: 16,
      durationMs: 300_000,
      maxOutputTokens: 16_384,
    })
  })
})
