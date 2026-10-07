/** Object storage access (Garage, S3-compatible). Streaming objects, authorized ranges and physical capacity for M3. */
import { S3Client } from 'bun'
import type { Config } from '../config/index.ts'
import type { BlobStore } from './port.ts'

export type { BlobStore } from './port.ts'

export function createBlobStore(config: Config['s3']): BlobStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  })
  return {
    // HEAD of a key that does not exist answers false (not an error) when endpoint, bucket and credentials work.
    ping: async () => {
      await client.exists('.readyz-probe')
    },
    async capacity() {
      if (!config.metricsToken) throw new Error('storage capacity probe unavailable')
      const response = await fetch(config.metricsEndpoint, {
        headers: { authorization: `Bearer ${config.metricsToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error('storage capacity probe failed')
      const text = await response.text()
      const read = (volume: string) => {
        const match = new RegExp(
          `^garage_local_disk_avail\\{volume="${volume}"\\} ([0-9.eE+]+)$`,
          'm',
        ).exec(text)
        const bytes = Number(match?.[1])
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid storage capacity')
        return bytes
      }
      return { dataFreeBytes: read('data'), metadataFreeBytes: read('metadata') }
    },
    async list(cursor) {
      const result = await client.list({
        prefix: 'att/',
        maxKeys: 1000,
        ...(cursor ? { continuationToken: cursor } : {}),
      })
      return {
        items: (result.contents ?? []).map((item) => ({ key: item.key, size: item.size ?? 0 })),
        nextCursor: result.nextContinuationToken ?? null,
      }
    },
    async put(key, stream, signal) {
      const writer = client.file(key).writer({
        type: 'application/octet-stream',
        partSize: 5 * 1024 * 1024,
        queueSize: 1,
        retry: 0,
      })
      const reader = stream.getReader()
      let bytes = 0
      let closing: Promise<unknown> | undefined
      const close = (error?: Error): Promise<unknown> => {
        closing ??= Promise.resolve().then(() => writer.end(error))
        return closing
      }
      const abort = () => {
        try {
          void close(new Error('storage_write_cancelled')).catch(() => undefined)
        } catch {
          /* already closed */
        }
        void reader.cancel().catch(() => undefined)
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        for (;;) {
          signal?.throwIfAborted()
          const chunk = await reader.read()
          signal?.throwIfAborted()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          writer.write(chunk.value)
          await writer.flush()
        }
        await close()
        signal?.throwIfAborted()
        return bytes
      } catch (error) {
        // Bun can commit partial bytes on end(error). Settle the writer before deleting them;
        // if storage is unavailable, the ledger intent retains capacity for the cleanup job.
        await close(new Error('storage_write_cancelled')).catch(() => undefined)
        await reader.cancel().catch(() => undefined)
        await client
          .file(key)
          .delete()
          .catch(() => undefined)
        throw error
      } finally {
        signal?.removeEventListener('abort', abort)
        reader.releaseLock()
      }
    },
    async stat(key) {
      if (!(await client.exists(key))) return null
      return { size: (await client.file(key).stat()).size }
    },
    read(key, start, end) {
      const file = client.file(key)
      return start === undefined ? file.stream() : file.slice(start, end).stream()
    },
    async delete(key) {
      await client.file(key).delete()
    },
  }
}
