/** Dual filtering: client diagnostic text is never forwarded, and the destination comes only from operator config. */
import {
  type MonitoringEvent,
  monitoringEventSchema,
  type OperationsHealth,
  operationsHealthSchema,
} from '@chatapp/contracts'
import { ConfigError } from '../config/env.ts'

export type Monitoring = {
  enabled: boolean
  send(event: MonitoringEvent): Promise<void>
  sendOperations?(health: OperationsHealth): Promise<void>
}
export function createMonitoring(
  source: Record<string, string | undefined>,
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Monitoring {
  if (!source.SENTRY_DSN) return { enabled: false, send: async () => {} }
  let dsn: URL
  try {
    dsn = new URL(source.SENTRY_DSN)
    if (
      dsn.protocol !== 'https:' ||
      dsn.port ||
      dsn.password ||
      dsn.search ||
      dsn.hash ||
      !/^[a-f0-9]{32}$/.test(dsn.username) ||
      !/^o[0-9]+\.ingest(?:\.(?:us|de))?\.sentry\.io$/.test(dsn.hostname) ||
      !/^\/[0-9]+$/.test(dsn.pathname)
    )
      throw new Error('invalid fixed Sentry destination')
  } catch {
    throw new ConfigError(['SENTRY_DSN: official HTTPS ingest origin and project required'])
  }
  const destination = `https://${dsn.hostname}/api${dsn.pathname}/envelope/`
  // Release binding is a server value, not a field a caller can fill with private content.
  const release = /^[a-f0-9]{64}$/.test(source.APPLICATION_SOURCE_HASH ?? '')
    ? source.APPLICATION_SOURCE_HASH
    : 'development'
  const post = async (
    type: string,
    value: string,
    tags: Record<string, string>,
    level: 'error' | 'info' = 'error',
  ) => {
    const id = crypto.randomUUID().replaceAll('-', '')
    const payload = JSON.stringify({
      event_id: id,
      platform: 'javascript',
      level,
      release,
      exception: { values: [{ type, value }] },
      tags,
    })
    const envelope = `${JSON.stringify({ event_id: id, dsn: dsn.href })}\n${JSON.stringify({ type: 'event', length: Buffer.byteLength(payload) })}\n${payload}\n`
    const response = await transport(destination, {
      method: 'POST',
      body: envelope,
      headers: { 'content-type': 'application/x-sentry-envelope' },
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error('monitoring transport unavailable')
  }
  return {
    enabled: true,
    send: async (input) => {
      const event = monitoringEventSchema.parse(input)
      await post(event.kind, 'Application error', { page: event.page })
    },
    sendOperations: async (input) => {
      const health = operationsHealthSchema.parse(input)
      await post(
        'OperationsAlert',
        'Operational condition changed',
        { status: health.status, problems: [...health.problems].sort().join(',') },
        health.status === 'healthy' ? 'info' : 'error',
      )
    },
  }
}
