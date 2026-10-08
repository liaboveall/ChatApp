/** Provider transport boundary. No ambient credentials, redirects, URL images or raw error logging. */
import { randomUUID } from 'node:crypto'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { Experimental_DownloadFunction } from 'ai'
import type { AiMode, AiProvider } from '../config/ai.ts'
import {
  type AiPrice,
  type AiUsage,
  type PaidCallLedger,
  parseDeepSeekUsage,
} from '../domain/ai-budget.ts'

export class AiTransportError extends Error {
  constructor(
    readonly code: 'REQUEST_REJECTED' | 'CALL_OUTCOME_UNKNOWN' | 'RESPONSE_INVALID',
    readonly httpStatus?: number,
  ) {
    super(code)
    this.name = 'AiTransportError'
  }
}

export type AiCallEvidence = {
  attemptId: string
  provider: Exclude<AiProvider, 'mock'>
  requestedModel: string
  actualModel?: string
  responseId?: string
  fingerprint?: string
  mode: AiMode
  streaming: boolean
  status: 'settled' | 'unknown' | 'released'
  httpStatus?: number
  retryAfterSeconds?: number
  usage?: AiUsage
}

type AiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** SDK preprocessing also runs for an empty URL list; only actual URL downloads are rejected. */
export const denyAiDownloads: Experimental_DownloadFunction = async (requests) => {
  if (requests.length > 0) throw new AiTransportError('REQUEST_REJECTED')
  return []
}

export function deepSeekOptions(mode: AiMode) {
  return {
    deepseek: {
      thinking: { type: mode === 'deep' ? ('enabled' as const) : ('disabled' as const) },
    },
  }
}

export function aiProviderOptions(provider: Exclude<AiProvider, 'mock'>, mode: AiMode) {
  if (provider === 'deepseek') return deepSeekOptions(mode)
  // GLM-5.3-Flash cannot disable thinking. Gateway support for effort must still be verified by V-01.
  return {
    soclaas: {
      thinking: { type: 'enabled', clear_thinking: false },
      reasoningEffort: mode === 'deep' ? 'high' : 'low',
    },
  }
}

export const AI_ENDPOINTS = {
  deepseek: 'https://api.deepseek.com',
  soclaas: 'https://soclaas-api.comp.nus.edu.sg/v1',
} as const

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

type GuardedAiOptions = {
  provider: Exclude<AiProvider, 'mock'>
  apiKey: string
  model: string
  mode: AiMode
  price: AiPrice
  label: string
  ledger: PaidCallLedger
  inputTokenBound: number
  maxOutputTokens: number
  onEvidence?: (evidence: AiCallEvidence) => unknown
  /** Injectable only for transport tests. The URL still must match the selected fixed provider endpoint. */
  fetch?: AiFetch
}

export function guardedDeepSeekModel(options: Omit<GuardedAiOptions, 'provider'>) {
  return guardedAiModel({ ...options, provider: 'deepseek' })
}

export function guardedAiModel(options: GuardedAiOptions) {
  if (!options.apiKey.trim()) throw new AiTransportError('REQUEST_REJECTED')
  if (
    options.provider === 'soclaas' &&
    [options.price.input, options.price.cachedInput, options.price.output].some(
      (rate) => rate !== 0,
    )
  )
    throw new AiTransportError('REQUEST_REJECTED')
  const send = options.fetch ?? fetch
  const guardedFetch: AiFetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (
      url !== `${AI_ENDPOINTS[options.provider]}/chat/completions` ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    )
      throw new AiTransportError('REQUEST_REJECTED')
    if (new Headers(init.headers).get('authorization') !== `Bearer ${options.apiKey}`)
      throw new AiTransportError('REQUEST_REJECTED')
    let body: Record<string, unknown> | undefined
    try {
      body = object(JSON.parse(init.body))
    } catch {
      throw new AiTransportError('REQUEST_REJECTED')
    }
    if (
      !body ||
      body.model !== options.model ||
      !Number.isSafeInteger(body.max_tokens) ||
      Number(body.max_tokens) <= 0 ||
      Number(body.max_tokens) > options.maxOutputTokens
    )
      throw new AiTransportError('REQUEST_REJECTED')
    const thinking =
      options.provider === 'soclaas' || options.mode === 'deep' ? 'enabled' : 'disabled'
    if (object(body.thinking)?.type !== thinking) throw new AiTransportError('REQUEST_REJECTED')
    if (
      options.provider === 'soclaas' &&
      body.reasoning_effort !== (options.mode === 'deep' ? 'high' : 'low')
    )
      throw new AiTransportError('REQUEST_REJECTED')
    // Only server-loaded bytes may enter image input. The provider/SDK must not fetch arbitrary model/user URLs.
    if (!Array.isArray(body.messages)) throw new AiTransportError('REQUEST_REJECTED')
    for (const message of body.messages) {
      const content = object(message)?.content
      if (!Array.isArray(content)) continue
      for (const raw of content) {
        const part = object(raw)
        if (part?.type === 'image_url') {
          const image = object(part.image_url)?.url
          if (
            typeof image !== 'string' ||
            !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(image) ||
            image.length > 1_400_000
          )
            throw new AiTransportError('REQUEST_REJECTED')
        } else if (part?.type !== 'text') throw new AiTransportError('REQUEST_REJECTED')
      }
    }
    const id = randomUUID()
    const evidence: AiCallEvidence = {
      attemptId: id,
      provider: options.provider,
      requestedModel: options.model,
      mode: options.mode,
      streaming: body.stream === true,
      status: 'unknown',
    }
    await options.ledger.reserve({
      id,
      label: options.label,
      model: options.model,
      price: options.price,
      inputTokenBound: options.inputTokenBound,
      maxOutputTokens: Number(body.max_tokens),
    })
    await options.ledger.start(id)
    let reported = false
    const report = async (status: AiCallEvidence['status']) => {
      if (reported) return
      reported = true
      evidence.status = status
      await options.onEvidence?.({ ...evidence })
    }
    const unknown = async () => {
      if (evidence.usage) {
        await options.ledger.settle(id, evidence.usage)
        await report('settled')
      } else {
        await options.ledger.unknown(id)
        await report('unknown')
      }
    }
    const capture = (value: unknown) => {
      const raw = object(value)
      if (!raw) return
      if (typeof raw.model === 'string') evidence.actualModel = raw.model
      if (typeof raw.id === 'string') evidence.responseId = raw.id
      if (typeof raw.system_fingerprint === 'string') evidence.fingerprint = raw.system_fingerprint
      if (raw.usage != null) {
        const usage = parseDeepSeekUsage(raw.usage)
        if (!usage) {
          evidence.usage = undefined
          throw new AiTransportError('RESPONSE_INVALID')
        }
        evidence.usage = usage
      }
    }
    const complete = async () => {
      if (evidence.usage) {
        await options.ledger.settle(id, evidence.usage)
        await report('settled')
      } else await unknown()
    }
    let response: Response
    try {
      response = await send(input, { ...init, redirect: 'error' })
    } catch {
      await unknown()
      throw new AiTransportError('CALL_OUTCOME_UNKNOWN')
    }
    evidence.httpStatus = response.status
    if (response.status === 429) {
      const raw = response.headers.get('retry-after')
      const seconds =
        raw && /^\d+$/.test(raw)
          ? Number(raw)
          : raw
            ? Math.ceil((Date.parse(raw) - Date.now()) / 1000)
            : 60
      evidence.retryAfterSeconds = Number.isFinite(seconds)
        ? Math.max(1, Math.min(86_400, seconds))
        : 60
    }
    if (!response.ok) {
      // Definitive admission rejections. 408 and 5xx may have started execution and keep their reservation.
      const rejected = [400, 401, 402, 403, 404, 422, 429].includes(response.status)
      if (rejected) {
        await options.ledger.release(id)
        await report('released')
      } else await unknown()
      await response.body?.cancel().catch(() => {})
      // A retryable SDK HTTP error would retry an attempt whose execution outcome is unknown.
      if (!rejected) throw new AiTransportError('CALL_OUTCOME_UNKNOWN', response.status)
      // Return a fixed vocabulary rather than forwarding provider errors that can echo request content.
      return new Response(
        JSON.stringify({
          error: {
            message: 'MODEL_REQUEST_FAILED',
            type: 'provider_error',
            code: String(response.status),
          },
        }),
        { status: response.status, headers: { 'content-type': 'application/json' } },
      )
    }
    if (!body.stream) {
      try {
        const text = await response.text()
        if (text.length > 2_000_000) throw new AiTransportError('RESPONSE_INVALID')
        capture(JSON.parse(text))
        await complete()
        return new Response(text, { status: response.status, headers: response.headers })
      } catch {
        await unknown()
        throw new AiTransportError('CALL_OUTCOME_UNKNOWN')
      }
    }
    if (!response.body) {
      await unknown()
      throw new AiTransportError('RESPONSE_INVALID')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    let ended = false
    function parseLines(final = false) {
      const lines = pending.split('\n')
      pending = final ? '' : (lines.pop() ?? '')
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          ended = true
          continue
        }
        if (data) capture(JSON.parse(data))
      }
      if (pending.length > 2_000_000) throw new AiTransportError('RESPONSE_INVALID')
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            pending += decoder.decode()
            parseLines(true)
            if (ended) await complete()
            else await unknown()
            controller.close()
            return
          }
          pending += decoder.decode(chunk.value, { stream: true })
          parseLines()
          controller.enqueue(chunk.value)
        } catch {
          await unknown()
          await reader.cancel().catch(() => {})
          controller.error(new AiTransportError('CALL_OUTCOME_UNKNOWN'))
        }
      },
      async cancel() {
        await unknown()
        await reader.cancel()
      },
    })
    return new Response(stream, { status: response.status, headers: response.headers })
  }
  const safeFetch = Object.assign(guardedFetch, { preconnect: () => {} })
  if (options.provider === 'soclaas') {
    const provider = createOpenAICompatible({
      name: 'soclaas',
      apiKey: options.apiKey,
      baseURL: AI_ENDPOINTS.soclaas,
      includeUsage: true,
      fetch: safeFetch,
    })
    return provider.chatModel(options.model)
  }
  const provider = createDeepSeek({
    apiKey: options.apiKey,
    baseURL: 'https://api.deepseek.com',
    // Bun adds preconnect to fetch's type. Keep it inert so every request still enters the budget guard.
    fetch: safeFetch,
  })
  return provider(options.model)
}
