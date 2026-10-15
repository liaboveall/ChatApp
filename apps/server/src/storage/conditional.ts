/** Private, bounded object I/O for the independent deletion journal. Never exposes signed URLs or service errors. */
import { S3Client } from 'bun'

export type OffsiteTarget = {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}
export interface ConditionalStore {
  read(key: string): Promise<{ bytes: Uint8Array; etag: string } | null>
  /** false means the precondition lost; an exception means the result may be unknown. */
  write(
    key: string,
    bytes: Uint8Array,
    condition: { etag: string } | { absent: true },
  ): Promise<boolean>
  list(
    prefix: string,
    cursor?: string,
    maxKeys?: number,
  ): Promise<{ keys: string[]; cursor?: string }>
  delete(key: string): Promise<void>
}

export class OffsiteError extends Error {
  constructor(readonly code: 'unavailable' | 'denied' | 'invalid_response' | 'too_large') {
    super(`offsite_${code}`)
    this.name = 'OffsiteError'
  }
}

export function createConditionalStore(
  target: OffsiteTarget,
  options: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): ConditionalStore {
  const client = new S3Client({ ...target, retry: 0 })
  const send = options.fetch ?? fetch
  const maxBytes = options.maxBytes ?? 256 * 1024
  const request = async (key: string, method: 'GET' | 'PUT' | 'DELETE', init?: RequestInit) => {
    if (!key || key.startsWith('/') || key.split('/').some((part) => part === '..'))
      throw new OffsiteError('invalid_response')
    try {
      return await send(client.file(key).presign({ method, expiresIn: 60 }), {
        ...init,
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      })
    } catch {
      throw new OffsiteError('unavailable')
    }
  }
  const reject = async (response: Response): Promise<never> => {
    await response.body?.cancel().catch(() => undefined)
    throw new OffsiteError([401, 403].includes(response.status) ? 'denied' : 'unavailable')
  }
  return {
    async read(key) {
      const response = await request(key, 'GET')
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) return await reject(response)
      const etag = response.headers.get('etag')
      if (!etag || !response.body) {
        await response.body?.cancel()
        throw new OffsiteError('invalid_response')
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          length += value.byteLength
          if (length > maxBytes) throw new OffsiteError('too_large')
          chunks.push(value)
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined)
        throw error instanceof OffsiteError ? error : new OffsiteError('unavailable')
      } finally {
        reader.releaseLock()
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return { bytes, etag }
    },
    async write(key, bytes, condition) {
      if (bytes.byteLength > maxBytes) throw new OffsiteError('too_large')
      const response = await request(key, 'PUT', {
        body: bytes,
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          ...('etag' in condition ? { 'if-match': condition.etag } : { 'if-none-match': '*' }),
        },
      })
      if ([409, 412].includes(response.status)) {
        await response.body?.cancel()
        return false
      }
      if (!response.ok) return await reject(response)
      await response.body?.cancel()
      return true
    },
    async list(prefix, cursor, maxKeys = 1000) {
      try {
        const result = await client.list({
          prefix,
          maxKeys,
          ...(cursor ? { continuationToken: cursor } : {}),
        })
        if (result.isTruncated && !result.nextContinuationToken)
          throw new OffsiteError('invalid_response')
        const keys = (result.contents ?? []).map((item) => item.key)
        if (keys.some((key) => !key.startsWith(prefix))) throw new OffsiteError('invalid_response')
        return {
          keys,
          ...(result.nextContinuationToken ? { cursor: result.nextContinuationToken } : {}),
        }
      } catch (error) {
        throw error instanceof OffsiteError ? error : new OffsiteError('unavailable')
      }
    },
    async delete(key) {
      const response = await request(key, 'DELETE')
      if (!response.ok && response.status !== 404) return await reject(response)
      await response.body?.cancel()
    },
  }
}
