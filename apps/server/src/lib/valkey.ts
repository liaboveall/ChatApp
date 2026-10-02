/**
 * Valkey access goes through ioredis everywhere (D-044). Offline queueing is off: when Valkey is unreachable a command
 * fails immediately, so rate limiting fails closed and nothing piles up in memory. Because of that, a client is only
 * handed out once it is connected.
 */
import { Redis } from 'ioredis'

export type Valkey = Redis

export type ValkeyOptions = {
  /** Resolve only once the connection is ready (default). Tests of the unreachable case turn this off. */
  waitReady?: boolean
  /** Called with connection errors; the error message is not forwarded because it may name hosts. */
  onError?: (error: Error) => void
}

export async function createValkey(
  url: string,
  name: string,
  options: ValkeyOptions = {},
): Promise<Valkey> {
  const client = new Redis(url, {
    connectionName: `chatapp-${name}`,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    commandTimeout: 2_000,
    // Reconnect forever with a ceiling; individual commands still fail fast while disconnected.
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  })
  // ioredis emits 'error' on every failed connection attempt; without a listener it would print them itself.
  client.on('error', (error) => options.onError?.(error))
  if (options.waitReady !== false) await waitUntilReady(client, 5_000)
  return client
}

function waitUntilReady(client: Redis, timeoutMs: number): Promise<void> {
  if (client.status === 'ready') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.disconnect()
      reject(new Error('Valkey did not become ready in time'))
    }, timeoutMs)
    client.once('ready', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Connection for BullMQ. It has different needs from the fail-fast client: Workers block on commands and require
 * `maxRetriesPerRequest: null`, and BullMQ manages its own offline handling.
 */
export function createBullConnection(url: string, name: string): Valkey {
  const client = new Redis(url, { connectionName: `chatapp-${name}`, maxRetriesPerRequest: null })
  client.on('error', () => undefined)
  return client
}
