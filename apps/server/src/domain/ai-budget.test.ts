import { describe, expect, test } from 'bun:test'
import { parseDeepSeekUsage, reserveCost, usageCost, usdToMicro } from './ai-budget.ts'

const price = { version: 'peak', input: 300_000, cachedInput: 6000, output: 1_200_000 }

describe('integer AI admission and settlement', () => {
  test('USD parsing is exact and rejects ambiguous, negative or unsafe amounts', () => {
    expect(usdToMicro('0.000001')).toBe(1)
    expect(usdToMicro('20')).toBe(20_000_000)
    for (const value of ['-1', '1e2', ' 20', '0.0000001', '01', 'NaN', '9007199255'])
      expect(() => usdToMicro(value)).toThrow()
  })
  test('reserves uncached input and all output including reasoning', () => {
    expect(reserveCost(price, 1000, 1000)).toBe(1500)
    expect(
      usageCost(price, {
        inputTokens: 1000,
        cachedTokens: 500,
        outputTokens: 100,
        reasoningTokens: 75,
      }),
    ).toBe(273)
  })
  test('rounds a fractional micro-dollar up, never below actual usage', () => {
    expect(
      usageCost(price, { inputTokens: 1, cachedTokens: 0, outputTokens: 0, reasoningTokens: null }),
    ).toBe(1)
  })
  test('rejects malformed usage, cache inconsistencies and reasoning double accounting', () => {
    for (const raw of [
      null,
      {},
      { prompt_tokens: -1, completion_tokens: 0 },
      { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 11 },
      { prompt_tokens: 10, completion_tokens: 1, total_tokens: 12 },
      {
        prompt_tokens: 10,
        completion_tokens: 1,
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    ])
      expect(parseDeepSeekUsage(raw)).toBeUndefined()
  })
  test('preserves absent reasoning breakdown and validates cache-miss fields', () => {
    expect(
      parseDeepSeekUsage({
        prompt_tokens: 10,
        completion_tokens: 4,
        prompt_cache_hit_tokens: 3,
        prompt_cache_miss_tokens: 7,
        total_tokens: 14,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 4, cachedTokens: 3, reasoningTokens: null })
    expect(
      parseDeepSeekUsage({
        prompt_tokens: 10,
        completion_tokens: 4,
        prompt_cache_hit_tokens: 3,
        prompt_cache_miss_tokens: 8,
      }),
    ).toBeUndefined()
  })
})
