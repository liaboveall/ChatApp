import { rename, rm, writeFile } from 'node:fs/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { processHealthSchema } from '@chatapp/contracts'

/** A recent event-loop heartbeat. Dependency outages are monitored separately; they must not restart every service. */
export function healthyWorker(value: unknown, now: number): boolean {
  return workerHealthStatus(value, now) === 'healthy'
}
export function workerHealthStatus(
  value: unknown,
  now: number,
): 'healthy' | 'invalid' | 'future' | 'stale' {
  const parsed = processHealthSchema.safeParse(value)
  if (!parsed.success || parsed.data.service !== 'worker') return 'invalid'
  if (parsed.data.updatedAt > now + 5000) return 'future'
  return now - parsed.data.updatedAt <= 35000 ? 'healthy' : 'stale'
}

export async function startProcessHealth(
  path: string | undefined,
  service: 'worker' | 'api' = 'worker',
) {
  if (!path) return { async stop() {} }
  if (!/^\/tmp\/chatapp-[a-z-]+\.json$/.test(path)) throw new Error('invalid process health path')
  let stopped = false
  let inFlight = Promise.resolve()
  const eventLoop = monitorEventLoopDelay({ resolution: 20 })
  eventLoop.enable()
  const update = () => {
    if (stopped) return
    inFlight = inFlight
      .catch(() => {})
      .then(async () => {
        if (stopped) return
        const temporary = `${path}.${process.pid}`
        await writeFile(
          temporary,
          JSON.stringify(
            processHealthSchema.parse({
              format: 1,
              service,
              pid: process.pid,
              updatedAt: Date.now(),
              eventLoop: {
                samples: eventLoop.count,
                p95Ms: eventLoop.count ? eventLoop.percentile(95) / 1e6 : 0,
                p99Ms: eventLoop.count ? eventLoop.percentile(99) / 1e6 : 0,
                maxMs: eventLoop.count ? eventLoop.max / 1e6 : 0,
              },
            }),
          ),
          { mode: 0o600 },
        )
        await rename(temporary, path)
      })
    // A failed write leaves the old heartbeat to expire; no unhandled rejection or secret-bearing diagnostic.
    void inFlight.catch(() => {})
  }
  update()
  await inFlight
  const timer = setInterval(update, 10000)
  timer.unref()
  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      eventLoop.disable()
      await inFlight.catch(() => {})
      await rm(path, { force: true })
    },
  }
}
