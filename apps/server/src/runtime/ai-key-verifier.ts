/**
 * Verifying a member's own DeepSeek key before it is stored (docs/06 section 14, V-17). The free model list answers
 * whether the key works without spending tokens; the request goes only to the fixed endpoint, follows no redirect, and
 * neither the key nor the provider's answer is logged or returned. Only the classification leaves this function.
 */
import type { AiKeyVerdict, AiKeyVerifier } from '../domain/ai-keys.ts'

type Fetch = (input: string, init: RequestInit) => Promise<Response>

export const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/models'

export function classifyKeyResponse(status: number, retryAfter: string | null): AiKeyVerdict {
  if (status >= 200 && status < 300) return { kind: 'valid' }
  if (status === 401 || status === 403) return { kind: 'invalid', reason: 'invalid' }
  if (status === 402) return { kind: 'invalid', reason: 'insufficient_balance' }
  if (status === 429) {
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : 60
    return { kind: 'rate_limited', retryAfterSeconds: Math.max(1, Math.min(3600, seconds)) }
  }
  return { kind: 'unavailable' }
}

export function deepSeekKeyVerifier(send: Fetch = fetch): AiKeyVerifier {
  return async (key) => {
    let response: Response
    try {
      response = await send(DEEPSEEK_MODELS_URL, {
        method: 'GET',
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      return { kind: 'unavailable' }
    }
    const verdict = classifyKeyResponse(response.status, response.headers.get('retry-after'))
    await response.body?.cancel().catch(() => {})
    return verdict
  }
}

/**
 * The test environment never calls a provider (docs/08 section 4). Keys spell their verdict; `sk-mock-revoked-…`
 * verifies now but is refused by the mock model later, as a key revoked after saving would be.
 */
export const mockKeyVerifier: AiKeyVerifier = async (key) => {
  if (key.startsWith('sk-mock-invalid')) return { kind: 'invalid', reason: 'invalid' }
  if (key.startsWith('sk-mock-broke')) return { kind: 'invalid', reason: 'insufficient_balance' }
  if (key.startsWith('sk-mock-limited')) return { kind: 'rate_limited', retryAfterSeconds: 30 }
  if (key.startsWith('sk-mock-')) return { kind: 'valid' }
  return { kind: 'invalid', reason: 'invalid' }
}
