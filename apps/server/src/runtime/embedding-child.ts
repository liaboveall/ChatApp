/** Credential-free, offline inference child. Owns a Unix socket, one inference at a time and a 1 GiB RSS watchdog. */
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { EMBEDDING_MODELS, type EmbeddingModelName } from './embedding-catalog.ts'
import { loadLocalEmbedder } from './embedding-model.ts'

const [socket, cache, name] = process.argv.slice(2)
if (
  !socket?.startsWith('/') ||
  !cache?.startsWith('/') ||
  !name ||
  !Object.hasOwn(EMBEDDING_MODELS, name)
)
  throw new Error('Invalid embedding child configuration')
const requestSchema = z.strictObject({
  text: z.string().min(1).max(20000),
  purpose: z.enum(['query', 'document']),
})
// The child is expendable under cgroup pressure; protect the worker's ordinary chat work.
await writeFile('/proc/self/oom_score_adj', '1000').catch(() => {})
const watchdog = setInterval(() => {
  if (process.memoryUsage().rss > 1024 ** 3) process.exit(75)
}, 50)
const model = await loadLocalEmbedder(name as EmbeddingModelName, cache)
await mkdir(dirname(socket), { recursive: true, mode: 0o700 })
// The owning parent checked that this endpoint had no live owner before starting us.
await unlink(socket).catch((error) => {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
})
let busy = false
const server = Bun.serve({
  unix: socket,
  maxRequestBodySize: 128 * 1024,
  async fetch(request) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/health')
      return Response.json({ modelVersion: model.modelVersion, dimension: model.dimension })
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/embed')
      return new Response(null, { status: 404 })
    if (busy) return new Response(null, { status: 503, headers: { 'Retry-After': '1' } })
    busy = true
    try {
      const parsed = requestSchema.safeParse(await request.json())
      if (!parsed.success) return new Response(null, { status: 422 })
      const vector = await model.embed(parsed.data.text, parsed.data.purpose)
      return Response.json({ modelVersion: model.modelVersion, dimension: model.dimension, vector })
    } catch {
      return new Response(null, { status: 503 })
    } finally {
      busy = false
    }
  },
})
await chmod(socket, 0o600)
const stop = async () => {
  clearInterval(watchdog)
  await server.stop(true)
  await model.close()
  await unlink(socket).catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
