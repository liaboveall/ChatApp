/**
 * Request budgets enforced BEFORE any parsing (D-078, SEC-38, AT-27): byte count (never trusting Content-Length),
 * read time, idle time, content type, content encoding and framing. The body is read once here; Hono's cache is
 * primed with the already-bounded text, so validators and handlers never touch the raw stream again.
 */
import { AppError, LIMITS } from '@chatapp/contracts'
import type { MiddlewareHandler } from 'hono'
import type { HttpEnv } from '../context.ts'

export type BodyBudget = { maxBytes: number; totalMs: number; idleMs: number }

export const JSON_BUDGET: BodyBudget = {
  maxBytes: LIMITS.jsonBodyBytes,
  totalMs: LIMITS.jsonReadTotalMs,
  idleMs: LIMITS.jsonReadIdleMs,
}

const JSON_CONTENT_TYPE = /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new AppError('REQUEST_TIMEOUT', 'Request body was not received in time')),
      ms,
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Reads at most `maxBytes`, with a total deadline and an idle limit between chunks. */
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  budget: BodyBudget,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const deadline = Date.now() + budget.totalMs
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0)
        throw new AppError('REQUEST_TIMEOUT', 'Request body was not received in time')
      const result = await withTimeout(reader.read(), Math.min(budget.idleMs, remaining))
      if (result.done) break
      size += result.value.byteLength
      if (size > budget.maxBytes) {
        throw new AppError('PAYLOAD_TOO_LARGE', `Request body exceeds ${budget.maxBytes} bytes`)
      }
      chunks.push(result.value)
    }
  } catch (error) {
    // Stop the upstream read; a client that keeps sending gets nothing more from us.
    await reader.cancel().catch(() => undefined)
    throw error
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export function bodyBudget(budget: BodyBudget = JSON_BUDGET): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()

    const headers = c.req.raw.headers
    const encoding = headers.get('content-encoding')
    if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Compressed request bodies are not accepted')
    }
    const lengthHeader = headers.get('content-length')
    const transferEncoding = headers.get('transfer-encoding')
    if (lengthHeader !== null && transferEncoding !== null) {
      throw new AppError('INVALID_REQUEST_FRAMING', 'Content-Length and Transfer-Encoding together')
    }
    if (transferEncoding !== null && transferEncoding.trim().toLowerCase() !== 'chunked') {
      throw new AppError('INVALID_REQUEST_FRAMING', 'Unsupported Transfer-Encoding')
    }
    let declared: number | undefined
    if (lengthHeader !== null) {
      if (!/^\d{1,15}$/.test(lengthHeader.trim())) {
        throw new AppError('INVALID_REQUEST_FRAMING', 'Invalid Content-Length')
      }
      declared = Number(lengthHeader.trim())
      if (declared > budget.maxBytes) {
        throw new AppError('PAYLOAD_TOO_LARGE', `Request body exceeds ${budget.maxBytes} bytes`)
      }
    }

    const stream = c.req.raw.body
    if (stream === null || declared === 0) return next() // no body: no Content-Type needed

    const contentType = headers.get('content-type') ?? ''
    if (!JSON_CONTENT_TYPE.test(contentType.trim())) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Only application/json is accepted')
    }
    const bytes = await readBounded(stream, budget)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (text.length > 0) JSON.parse(text)
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Request body is not valid JSON', {
        details: { reason: 'malformed_json' },
      })
    }
    // Later `c.req.json()` / validators read the cache, not the (consumed) stream.
    // Hono stores promises in its body cache although its types say otherwise; a test pins this behaviour.
    ;(c.req.bodyCache as unknown as Record<string, Promise<string>>).text = Promise.resolve(text)
    await next()
  }
}
