/** Integer micro-dollar accounting shared by paid experiments and the M4 transaction ledger (D-062). */
export type AiPrice = {
  version: string
  /** Micro-dollars per million tokens. */
  input: number
  cachedInput: number
  output: number
}

export type AiUsage = {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  /** Included in outputTokens, never charged a second time. */
  reasoningTokens: number | null
}

export class AiBudgetError extends Error {
  constructor(
    readonly code:
      | 'INVALID_AMOUNT'
      | 'INVALID_USAGE'
      | 'BUDGET_EXHAUSTED'
      | 'BUDGET_HALTED'
      | 'ATTEMPT_CONFLICT',
  ) {
    super(code)
    this.name = 'AiBudgetError'
  }
}

function integer(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/** Parse USD without a floating-point multiplication or rounding down an admission limit. */
export function usdToMicro(value: string): number {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value)
  if (!match) throw new AiBudgetError('INVALID_AMOUNT')
  const result = BigInt(match[1] ?? '0') * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'))
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new AiBudgetError('INVALID_AMOUNT')
  return Number(result)
}

export function usageCost(price: AiPrice, usage: AiUsage): number {
  if (
    ![price.input, price.cachedInput, price.output].every(integer) ||
    price.cachedInput > price.input ||
    ![usage.inputTokens, usage.outputTokens, usage.cachedTokens].every(integer) ||
    usage.cachedTokens > usage.inputTokens ||
    (usage.reasoningTokens !== null &&
      (!integer(usage.reasoningTokens) || usage.reasoningTokens > usage.outputTokens))
  )
    throw new AiBudgetError('INVALID_USAGE')
  const numerator =
    BigInt(usage.inputTokens - usage.cachedTokens) * BigInt(price.input) +
    BigInt(usage.cachedTokens) * BigInt(price.cachedInput) +
    BigInt(usage.outputTokens) * BigInt(price.output)
  const result = (numerator + 999_999n) / 1_000_000n
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new AiBudgetError('INVALID_AMOUNT')
  return Number(result)
}

export function reserveCost(
  price: AiPrice,
  inputTokenBound: number,
  maxOutputTokens: number,
): number {
  return usageCost(price, {
    inputTokens: inputTokenBound,
    outputTokens: maxOutputTokens,
    cachedTokens: 0,
    reasoningTokens: null,
  })
}

/** Inspect the provider's original usage; an empty SDK usage must not become a zero-cost success. */
export function parseDeepSeekUsage(value: unknown): AiUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const input = record.prompt_tokens
  const output = record.completion_tokens
  const inputDetails = record.prompt_tokens_details
  const cached =
    record.prompt_cache_hit_tokens ??
    (inputDetails !== null && typeof inputDetails === 'object'
      ? (inputDetails as Record<string, unknown>).cached_tokens
      : undefined) ??
    0
  const details = record.completion_tokens_details
  const reasoning =
    details !== null && typeof details === 'object'
      ? ((details as Record<string, unknown>).reasoning_tokens ?? null)
      : null
  if (typeof input !== 'number' || typeof output !== 'number' || typeof cached !== 'number')
    return undefined
  if (reasoning !== null && typeof reasoning !== 'number') return undefined
  const usage = {
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    reasoningTokens: reasoning,
  }
  try {
    usageCost({ version: 'validate', input: 0, cachedInput: 0, output: 0 }, usage)
    if (record.total_tokens !== undefined && record.total_tokens !== input + output)
      return undefined
    if (
      record.prompt_cache_miss_tokens !== undefined &&
      record.prompt_cache_miss_tokens !== input - cached
    )
      return undefined
    return usage
  } catch {
    return undefined
  }
}

export type PaidAttempt = {
  id: string
  label: string
  model: string
  price: AiPrice
  inputTokenBound: number
  maxOutputTokens: number
}

/** Production implements this port with locked Postgres accounts; experiments use a separate SQLite ledger. */
export interface PaidCallLedger {
  reserve(attempt: PaidAttempt): unknown
  start(id: string): unknown
  settle(id: string, usage: AiUsage): unknown
  unknown(id: string): unknown
  release(id: string): unknown
}
