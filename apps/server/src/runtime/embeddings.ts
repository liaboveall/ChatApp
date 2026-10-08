import { AppError } from '@chatapp/contracts'
import { z } from 'zod'
import type { Deps } from '../domain/deps.ts'
import { validVector } from '../domain/embeddings.ts'
import { EMBEDDING_MODELS, type EmbeddingModelName } from './embedding-catalog.ts'

export function embeddingSettings(source: Record<string, string | undefined>) {
  if (
    source.EMBEDDING_ENABLED !== undefined &&
    !['true', 'false'].includes(source.EMBEDDING_ENABLED)
  )
    throw new Error('EMBEDDING_ENABLED must be true or false')
  const enabled = source.EMBEDDING_ENABLED === 'true'
  const name = source.EMBEDDING_MODEL ?? 'bge'
  if (!Object.hasOwn(EMBEDDING_MODELS, name)) throw new Error('EMBEDDING_MODEL must be qwen or bge')
  const socket = source.EMBEDDING_SOCKET_PATH ?? '/run/chatapp-embedding/embedding.sock'
  const cache = source.EMBEDDING_CACHE_DIR ?? '/var/lib/chatapp/models'
  if (!socket.startsWith('/') || !cache.startsWith('/'))
    throw new Error('Embedding paths must be absolute')
  return { enabled, name: name as EmbeddingModelName, socket, cache }
}
const answerSchema = z.object({
  modelVersion: z.string(),
  dimension: z.number().int(),
  vector: z.array(z.number().finite()).max(1024),
})
export function createEmbeddingClient(
  settings: ReturnType<typeof embeddingSettings>,
): NonNullable<Deps['embeddings']> {
  const model = EMBEDDING_MODELS[settings.name]
  return {
    modelVersion: model.version,
    dimension: model.dimension,
    async embed(text, purpose) {
      try {
        const response = await fetch('http://embedding.local/embed', {
          unix: settings.socket,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, purpose }),
          signal: AbortSignal.timeout(20000),
          redirect: 'error',
        })
        if (!response.ok) throw new Error('local inference failed')
        if (!response.body) throw new Error('empty inference response')
        const chunks: Uint8Array[] = [],
          reader = response.body.getReader()
        let bytes = 0
        try {
          for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > 64000) throw new Error('unbounded inference response')
            chunks.push(chunk.value)
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
        const buffer = new Uint8Array(bytes)
        let offset = 0
        for (const chunk of chunks) {
          buffer.set(chunk, offset)
          offset += chunk.byteLength
        }
        const body = new TextDecoder().decode(buffer)
        const answer = answerSchema.parse(JSON.parse(body))
        if (
          answer.modelVersion !== model.version ||
          answer.dimension !== model.dimension ||
          answer.vector.length !== model.dimension ||
          !validVector(answer.vector, model.dimension)
        )
          throw new Error('model identity mismatch')
        return answer.vector
      } catch {
        throw new AppError(
          'CAPACITY_UNAVAILABLE',
          'Local semantic search is temporarily unavailable',
        )
      }
    },
  }
}
/** Only the worker creates the child; the API communicates via IPC. The child inherits the worker cgroup, not its credentials. */
export async function startEmbeddingChild(settings: ReturnType<typeof embeddingSettings>) {
  if (!settings.enabled) return { pid: undefined, exited: Promise.resolve(0), async stop() {} }
  try {
    const response = await fetch('http://embedding.local/health', {
      unix: settings.socket,
      signal: AbortSignal.timeout(1000),
    })
    if (response.ok) throw new Error('Embedding socket already has an owner')
  } catch (error) {
    if (error instanceof Error && error.message === 'Embedding socket already has an owner')
      throw error
  }
  const child = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      `${import.meta.dir}/embedding-child.ts`,
      settings.socket,
      settings.cache,
      settings.name,
    ],
    {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HF_HUB_OFFLINE: '1' },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  )
  let stopped = false
  // A failed native child stays unavailable; it cannot take down ordinary chat or trigger remote inference.
  void child.exited
  return {
    pid: child.pid,
    exited: child.exited,
    async stop() {
      if (stopped) return
      stopped = true
      child.kill('SIGTERM')
      let timeout: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        child.exited,
        new Promise((resolve) => {
          timeout = setTimeout(() => {
            child.kill('SIGKILL')
            resolve(0)
          }, 5000)
        }),
      ])
      clearTimeout(timeout)
    },
  }
}
