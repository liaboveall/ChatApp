/** Real, offline Unix IPC probe. This records local evidence; it never certifies mixed-load native ARM resources. */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { EMBEDDING_MODELS } from '../src/runtime/embedding-catalog.ts'
import {
  createEmbeddingClient,
  embeddingSettings,
  startEmbeddingChild,
} from '../src/runtime/embeddings.ts'

const name = process.argv[2] === 'qwen' ? 'qwen' : 'bge',
  model = EMBEDDING_MODELS[name],
  dir = resolve('.test-runs/m5', `ipc-${name}-${randomUUID()}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
const settings = embeddingSettings({
  EMBEDDING_ENABLED: 'true',
  EMBEDDING_MODEL: name,
  EMBEDDING_SOCKET_PATH: join(dir, 'embedding.sock'),
  EMBEDDING_CACHE_DIR: resolve('.test-runs/m5/models'),
})
process.env.SOCLAAS_API_KEY = 'CANARY_PARENT_ONLY'
process.env.DATABASE_URL = 'CANARY_PARENT_DATABASE'
const child = await startEmbeddingChild(settings),
  port = createEmbeddingClient(settings),
  durations: number[] = [],
  rss: number[] = []
let ready = false,
  exitCode: number | undefined
void child.exited.then((code) => {
  exitCode = code
})
try {
  for (let i = 0; i < 100; i++) {
    if (child.pid) {
      try {
        const status = await readFile(`/proc/${child.pid}/status`, 'utf8')
        rss.push(Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024)
      } catch {}
    }
    if (exitCode !== undefined) break
    try {
      const response = await fetch('http://embedding.local/health', {
        unix: settings.socket,
        signal: AbortSignal.timeout(200),
      })
      if (response.ok) {
        ready = true
        break
      }
    } catch {}
    await delay(100)
  }
  if (!ready || !child.pid)
    throw new Error(
      'Offline child did not become ready; resource watchdog may have refused the model',
    )
  const environment = await readFile(`/proc/${child.pid}/environ`, 'utf8')
  if (
    environment.includes('CANARY_PARENT') ||
    environment.includes('SOCLAAS_API_KEY=') ||
    environment.includes('DATABASE_URL=')
  )
    throw new Error('Child inherited business credentials')
  if (((await stat(settings.socket)).mode & 0o777) !== 0o600)
    throw new Error('IPC socket permissions too wide')
  try {
    await startEmbeddingChild(settings)
    throw new Error('duplicate child owner was accepted')
  } catch (error) {
    if (!(error instanceof Error && error.message === 'Embedding socket already has an owner'))
      throw error
  }
  for (let i = 0; i < 30; i++) {
    const start = performance.now(),
      text =
        i % 5 === 0
          ? `${'今天记录工作安排。'.repeat(90)}最后保留历史数据。`
          : '项目安排：明天下午三点发布，由林舟负责。'
    const v = await port.embed(text, 'document')
    if (v.length !== model.dimension || !v.every(Number.isFinite))
      throw new Error('Invalid IPC result')
    durations.push(performance.now() - start)
    const status = await readFile(`/proc/${child.pid}/status`, 'utf8')
    rss.push(Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024)
  }
  const result = {
    modelVersion: model.version,
    architecture: process.arch,
    native: true,
    cpuThreads: 2,
    offline: true,
    credentialIsolation: true,
    socketMode: '0600',
    p95Ms: [...durations].sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1],
    childPeakBytes: Math.max(...rss),
    mixedLoad: false,
    armResourcesPass: false,
  }
  await writeFile(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ directory: dir, ...result }))
} catch (error) {
  const result = {
    modelVersion: model.version,
    architecture: process.arch,
    ready,
    exitCode,
    childPeakBytes: Math.max(0, ...rss),
    armResourcesPass: false,
    passed: false,
    error: error instanceof Error ? error.message : 'IPC failure',
  }
  await writeFile(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify({ directory: dir, ...result }))
  process.exitCode = 1
} finally {
  await child.stop()
}
