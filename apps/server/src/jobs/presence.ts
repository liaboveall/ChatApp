/**
 * The presence sweeper (docs/03 section 5.6, step 4): every 30 seconds the worker removes connections that stopped
 * renewing, for example those of an API process that crashed, and announces the people who went offline because of it.
 * It runs in the worker, not in the API, precisely because the process that owned the connections may be gone.
 */
import type { Deps } from '../domain/deps.ts'
import { touchLastSeen } from '../domain/presence.ts'
import { describeError, type Logger } from '../lib/logger.ts'
import type { EventBus } from '../realtime/bus.ts'
import type { PresenceStore } from '../realtime/presence.ts'

export type PresenceSweeper = {
  start(): void
  stop(): Promise<void>
  /** One pass; exposed for tests. Returns how many people changed status. */
  sweep(): Promise<number>
}

export function createPresenceSweeper(parts: {
  deps: Pick<Deps, 'db' | 'clock'>
  store: PresenceStore
  bus: EventBus
  log: Logger
  intervalMs?: number
}): PresenceSweeper {
  const { deps, store, bus, log } = parts
  let timer: ReturnType<typeof setInterval> | undefined
  let running: Promise<number> | undefined

  async function sweep(): Promise<number> {
    const changes = await store.sweep(deps.clock.now().getTime())
    for (const change of changes) {
      try {
        let lastSeenAt: string | null = null
        if (change.current === 'offline') {
          const at = deps.clock.now()
          await touchLastSeen(deps, change.userId, at)
          lastSeenAt = at.toISOString()
        }
        await bus.publish({
          type: 'presence',
          userId: change.userId,
          status: change.current,
          lastSeenAt,
        })
      } catch (error) {
        log.warn('presence.announce_failed', describeError(error))
      }
    }
    return changes.length
  }

  return {
    start() {
      timer = setInterval(() => {
        if (running) return
        running = sweep()
          .catch((error) => {
            log.warn('presence.sweep_failed', describeError(error))
            return 0
          })
          .finally(() => {
            running = undefined
          })
      }, parts.intervalMs ?? 30_000)
    },
    async stop() {
      if (timer) clearInterval(timer)
      await running
    },
    sweep,
  }
}
