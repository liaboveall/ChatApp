import { expect, test } from 'bun:test'
import { monitoringEventSchema } from '@chatapp/contracts'
import { createMonitoring } from './monitoring.ts'

test('a caller cannot supply a destination, secret, request, stack or raw error; relay output is independently filtered', async () => {
  let destination = '',
    body = '',
    settings: RequestInit | undefined
  const transport = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    destination = String(url)
    body = String(init?.body)
    settings = init
    return new Response('', { status: 200 })
  }) as typeof fetch
  const monitor = createMonitoring(
    {
      SENTRY_DSN: `https://${'a'.repeat(32)}@o123.ingest.us.sentry.io/45`,
      APPLICATION_SOURCE_HASH: 'b'.repeat(64),
    },
    transport,
  )
  expect(() =>
    monitoringEventSchema.parse({ kind: 'Error', page: 'chat', message: 'private message' }),
  ).toThrow()
  await expect(
    monitor.send({ kind: 'Error', page: 'chat', dsn: 'https://localhost' } as unknown as Parameters<
      typeof monitor.send
    >[0]),
  ).rejects.toThrow()
  await monitor.send({ kind: 'TypeError', page: 'chat' })
  expect(destination).toBe('https://o123.ingest.us.sentry.io/api/45/envelope/')
  const lines = body.trim().split('\n'),
    event = JSON.parse(lines[2] ?? '{}')
  expect(Object.keys(event).sort()).toEqual([
    'event_id',
    'exception',
    'level',
    'platform',
    'release',
    'tags',
  ])
  expect(event.exception.values).toEqual([{ type: 'TypeError', value: 'Application error' }])
  expect(body).not.toContain('private message')
  expect(body).not.toContain('stacktrace')
  expect(settings?.credentials).toBe('omit')
  expect(settings?.redirect).toBe('error')
  for (const dsn of [
    'https://localhost/1',
    'https://' + 'a'.repeat(32) + '@evil.example/1',
    'https://' + 'a'.repeat(32) + '@o1.ingest.sentry.io/1?redirect=evil',
  ])
    expect(() => createMonitoring({ SENTRY_DSN: dsn })).toThrow()
})
test('unconfigured monitoring never makes a network request', async () => {
  const monitor = createMonitoring({}, () => {
    throw new Error('unexpected send')
  })
  expect(monitor.enabled).toBe(false)
  await monitor.send({ kind: 'Error', page: 'auth' })
})
