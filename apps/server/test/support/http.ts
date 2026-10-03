import { createAuth } from '../../src/auth/better-auth.ts'
import { type AppOptions, createApp } from '../../src/http/app.ts'
import type { Services } from '../../src/http/context.ts'
import type { ManualClock } from '../../src/lib/clock.ts'
import { createClientIpResolver } from '../../src/lib/ip.ts'
import { createLogger, type Logger } from '../../src/lib/logger.ts'
import { RateLimiter } from '../../src/lib/rate-limit.ts'
import { createValkey, type Valkey } from '../../src/lib/valkey.ts'
import type { TestDatabases } from './db.ts'
import { makeDeps, TEST_ORIGIN } from './deps.ts'
import { testConfig } from './env.ts'

const SECRET = 'k3Jx9QvLm2ZpWn8RtYb4HcDf7GsAe1UoIiTqVyPz'

export type CookieJar = Map<string, string>
export type RawBody = string | Uint8Array | ReadableStream<Uint8Array> | null

/** Reads Set-Cookie lines into a jar: deletions (Max-Age=0 or empty value) remove the cookie. */
export function absorbCookies(jar: CookieJar, response: Response): void {
  for (const line of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = line.split(';').map((part) => part.trim())
    const eq = pair.indexOf('=')
    const name = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    const expired = attributes.some((a) => /^max-age=0$/i.test(a)) || value === ''
    if (expired) jar.delete(name)
    else jar.set(name, value)
  }
}

export type RequestOptions = {
  method?: string
  json?: unknown
  /** Raw body, for budget tests. */
  body?: RawBody
  headers?: Record<string, string>
  jar?: CookieJar
  /** Defaults to the site origin; pass null to send none. */
  origin?: string | null
  /** Connecting peer, and the client IP behind a trusted proxy via X-Forwarded-For. */
  peer?: string
  forwardedFor?: string
}

export type TestApp = {
  app: ReturnType<typeof createApp>
  services: Services
  clock: ManualClock
  logs: string[]
  valkey: Valkey
  request: (path: string, options?: RequestOptions) => Promise<Response>
  newJar: () => CookieJar
  close: () => Promise<void>
}

export async function createTestApp(
  dbs: TestDatabases,
  options: {
    appOptions?: AppOptions
    log?: Logger
    /** For example `{ env: 'production' }` to inspect what a production app registers. */
    config?: Partial<ReturnType<typeof testConfig>>
    /** Another Valkey than the shared test one (rate limits live there): the isolated instance of the fault suite. */
    valkeyUrl?: string
  } = {},
): Promise<TestApp> {
  const config = testConfig()
  const logs: string[] = []
  const log =
    options.log ??
    createLogger({
      level: 'debug',
      destination: { write: (chunk: string) => void logs.push(chunk) },
    })
  const deps = makeDeps(dbs.app.db, { log })
  const valkey = await createValkey(options.valkeyUrl ?? config.valkeyUrl, 'test-http')
  const runId = Math.random().toString(36).slice(2)
  const services: Services = {
    config: { ...config, origin: TEST_ORIGIN, ...options.config },
    deps,
    auth: createAuth(deps, { baseOrigin: TEST_ORIGIN, secret: SECRET }),
    limiter: new RateLimiter(valkey, `test-http-${runId}`),
    log,
    resolveClientIp: createClientIpResolver(['127.0.0.1', '::1']),
    isReady: async () => true,
    wake: () => undefined,
  }
  const app = createApp(services, options.appOptions)

  const request = async (path: string, init: RequestOptions = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    const origin = init.origin === undefined ? TEST_ORIGIN : init.origin
    if (origin !== null) headers.set('origin', origin)
    if (init.forwardedFor !== undefined) headers.set('x-forwarded-for', init.forwardedFor)
    if (init.jar && init.jar.size > 0) {
      headers.set('cookie', [...init.jar].map(([name, value]) => `${name}=${value}`).join('; '))
    }
    let body: RawBody | undefined = init.body
    if (init.json !== undefined) {
      body = JSON.stringify(init.json)
      if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    }
    const response = await app.request(
      `${TEST_ORIGIN}${path}`,
      { method: init.method ?? (body ? 'POST' : 'GET'), headers, body },
      { peerAddress: () => init.peer ?? '127.0.0.1' },
    )
    if (init.jar) absorbCookies(init.jar, response)
    return response
  }

  return {
    app,
    services,
    clock: deps.clock,
    logs,
    valkey,
    request,
    newJar: () => new Map(),
    close: async () => {
      try {
        const keys = await valkey.keys(`rl:test-http-${runId}:*`)
        if (keys.length > 0) await valkey.del(...keys)
      } catch {
        // Valkey is away or has only just returned (a fault test took it down): the counters carry their own expiry and
        // belong to this run alone, so leaving them is harmless, and a test must not fail on its own tidying up.
      }
      valkey.disconnect()
    },
  }
}
