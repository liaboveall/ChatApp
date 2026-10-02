/**
 * Pub/Sub on Valkey with ioredis (D-044). The channel name carries the environment (`events:{APP_ENV}`), because
 * Pub/Sub ignores Valkey database numbers and a development server must not hear the test suite. Delivery is
 * best-effort: a missed message only delays what the 5-second recheck and the work_items scan guarantee anyway.
 */
import type { Logger } from '../lib/logger.ts'
import type { Valkey } from '../lib/valkey.ts'
import { type BusEvent, busEventSchema } from './events.ts'

export interface EventBus {
  publish(event: BusEvent): Promise<void>
  /** Returns an unsubscribe function. */
  subscribe(handler: (event: BusEvent) => void): Promise<() => Promise<void>>
}

export function createEventBus(parts: {
  publisher: Valkey
  /** A dedicated connection: once subscribed it can run no other commands. */
  subscriber: Valkey
  channel: string
  log: Logger
}): EventBus {
  return {
    publish: async (event) => {
      await parts.publisher.publish(parts.channel, JSON.stringify(event))
    },
    subscribe: async (handler) => {
      const listener = (channel: string, message: string) => {
        if (channel !== parts.channel) return
        let parsed: ReturnType<typeof busEventSchema.safeParse>
        try {
          parsed = busEventSchema.safeParse(JSON.parse(message))
        } catch {
          parsed = busEventSchema.safeParse(undefined)
        }
        if (!parsed.success) {
          parts.log.warn('bus.invalid_message', { reason: 'schema' })
          return
        }
        handler(parsed.data)
      }
      parts.subscriber.on('message', listener)
      await parts.subscriber.subscribe(parts.channel)
      return async () => {
        parts.subscriber.off('message', listener)
        await parts.subscriber.unsubscribe(parts.channel).catch(() => undefined)
      }
    },
  }
}
