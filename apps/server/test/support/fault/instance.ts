/**
 * The isolated fault-test instance as the fault suite uses it (D-085, AT-34): the verified target, connections to its
 * Postgres and Valkey, and real `api` and `worker` processes that can reach this instance and nothing else, which tests
 * can kill, pause and resume. Nothing here runs unless `CHATAPP_FAULT_MANIFEST` names a manifest that verifies, so a fault
 * can only ever land on resources created for the run (`bun run test:fault`).
 */
import { fileURLToPath } from 'node:url'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { createDatabase, type Database } from '@chatapp/db/client'
import { Redis } from 'ioredis'
import { truncateAll } from '../db.ts'
import {
  type FaultManifest,
  type FaultTarget,
  loadManifest,
  verifyFaultTarget,
} from './manifest.ts'

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
export const FAULT_ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173'

export type FaultDatabases = { app: Database; owner: Database; close: () => Promise<void> }

export type FaultInstance = {
  manifest: FaultManifest
  target: FaultTarget
  databases: FaultDatabases
  /** The instance's Mailpit HTTP API, when the manifest records its port. */
  mailpit: string | undefined
  /** Empties the instance for the next test (tables, Valkey and its mailbox), bootstrapped again, marker restored. */
  reset: () => Promise<void>
  /** A fresh connection to the instance's Valkey (the caller disconnects it). */
  valkey: () => Redis
  close: () => Promise<void>
}

export async function openFaultInstance(): Promise<FaultInstance> {
  const path = process.env.CHATAPP_FAULT_MANIFEST
  if (!path)
    throw new Error('CHATAPP_FAULT_MANIFEST is not set: run this suite with `bun run test:fault`')
  if (process.env.APP_ENV !== 'test') throw new Error('APP_ENV must be test')
  const manifest = loadManifest(path)
  const target = await verifyFaultTarget(manifest)
  const e = manifest.endpoints
  const app = createDatabase(e.databaseUrl, { max: 5, applicationName: 'chatapp-fault-app' })
  const owner = createDatabase(e.databaseOwnerUrl, {
    max: 2,
    applicationName: 'chatapp-fault-owner',
  })
  const databases: FaultDatabases = {
    app,
    owner,
    close: async () => {
      await app.close()
      await owner.close()
    },
  }
  const mailpit = e.mailpitUiPort ? `http://127.0.0.1:${e.mailpitUiPort}` : undefined
  const valkey = () => new Redis(e.valkeyUrl)
  return {
    manifest,
    target,
    databases,
    mailpit,
    valkey,
    reset: async () => {
      await truncateAll(owner)
      await runBootstrap(owner.db, {
        agentUsername: 'assistant',
        agentDisplayName: '助手',
        productName: 'ChatApp',
      })
      const client = valkey()
      try {
        await client.flushall()
        // FLUSHALL took the instance marker too; without it the instance would no longer verify.
        await client.set('chatapp:instance-marker', manifest.markers.valkey)
      } finally {
        client.disconnect()
      }
      if (mailpit)
        await fetch(`${mailpit}/api/v1/messages`, { method: 'DELETE' }).catch(() => undefined)
    },
    close: async () => {
      await databases.close()
    },
  }
}

/** Waits for a condition of the world (not for time); the guard only keeps a failure from hanging. */
export async function waitUntil<T>(
  read: () => Promise<T | undefined | false> | T | undefined | false,
  options: { guardMs?: number; intervalMs?: number; what?: string } = {},
): Promise<T> {
  const until = Date.now() + (options.guardMs ?? 20_000)
  for (;;) {
    const value = await Promise.resolve(read()).catch(() => undefined)
    if (value !== undefined && value !== false) return value
    if (Date.now() > until)
      throw new Error(`not reached in time: ${options.what ?? 'the condition'}`)
    await Bun.sleep(options.intervalMs ?? 50)
  }
}

// ───────── real processes ─────────

/** Variables that could point a process at a development service: every one is replaced by this instance's own. */
function environmentFor(
  instance: FaultInstance,
  extra: Record<string, string>,
): Record<string, string> {
  const e = instance.manifest.endpoints
  const own: Record<string, string> = {
    APP_ENV: 'test',
    LOG_LEVEL: 'warn',
    API_HOST: '127.0.0.1',
    DATABASE_URL: e.databaseUrl,
    DATABASE_URL_TEST: e.databaseUrl,
    DATABASE_OWNER_URL: e.databaseOwnerUrl,
    DATABASE_OWNER_URL_TEST: e.databaseOwnerUrl,
    // Pub/Sub ignores database numbers; the configuration still insists the test one differs from the other.
    VALKEY_URL: e.valkeyUrl.replace(/\/1$/, '/0'),
    VALKEY_URL_TEST: e.valkeyUrl,
    S3_ENDPOINT: e.s3Endpoint,
    S3_BUCKET: 'chatapp-unused',
    S3_BUCKET_TEST: e.s3Bucket,
    S3_ACCESS_KEY_ID: e.s3AccessKeyId,
    S3_SECRET_ACCESS_KEY: e.s3SecretAccessKey,
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(e.smtpPort),
    SMTP_USER: '',
    SMTP_PASS: '',
    ...extra,
  }
  return { ...(process.env as Record<string, string>), ...own }
}

export type Service = {
  kind: 'api' | 'worker'
  pid: number
  /** The last lines the process wrote, for the report of a failure (they carry identifiers and codes, no secrets). */
  logTail: () => string
  /** SIGKILL, SIGSTOP (pause) or SIGCONT (resume). */
  signal: (name: 'SIGKILL' | 'SIGSTOP' | 'SIGCONT') => void
  exited: Promise<number | null>
  /** Ends it for good (SIGKILL) and waits until it is gone. */
  stop: () => Promise<void>
}

export type ApiService = Service & { port: number; baseUrl: string }

function freePort(): number {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

/**
 * Processes that are still running. A test that ends without stopping its own (a crash, an uncaught error) must not leave
 * them behind to poll an instance that is about to be removed, so whatever is left goes down with the test process.
 */
const running = new Set<{ kill: (signal?: NodeJS.Signals) => void }>()
let guarding = false

function guardLeftovers(): void {
  if (guarding) return
  guarding = true
  process.once('exit', () => {
    for (const child of running) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })
}

function spawnProcess(
  kind: 'api' | 'worker',
  instance: FaultInstance,
  extra: Record<string, string>,
): Service {
  const lines: string[] = []
  const child = Bun.spawn(
    ['bun', kind === 'api' ? 'apps/server/src/api.ts' : 'apps/server/src/worker.ts'],
    {
      cwd: ROOT,
      env: environmentFor(instance, extra),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  running.add(child)
  guardLeftovers()
  void child.exited.then(() => running.delete(child))
  for (const stream of [child.stdout, child.stderr]) {
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) {
        lines.push(...decoder.decode(chunk).split('\n').filter(Boolean))
        if (lines.length > 200) lines.splice(0, lines.length - 200)
      }
    })()
  }
  return {
    kind,
    pid: child.pid,
    logTail: () => lines.slice(-20).join('\n'),
    signal: (name) => {
      child.kill(name)
    },
    exited: child.exited,
    stop: async () => {
      child.kill('SIGKILL')
      await child.exited
    },
  }
}

/** A real API process on a free loopback port, ready to answer. */
export async function startApi(instance: FaultInstance): Promise<ApiService> {
  const port = freePort()
  const service = spawnProcess('api', instance, { API_PORT: String(port) })
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitUntil(async () => (await fetch(`${baseUrl}/api/readyz`)).ok, {
      guardMs: 40_000,
      intervalMs: 100,
      what: 'the api to become ready',
    })
  } catch (error) {
    await service.stop()
    throw new Error(`${(error as Error).message}\n${service.logTail()}`)
  }
  return { ...service, port, baseUrl }
}

/** A real worker process (dispatcher, consumers, scans). It has no port: a started process is a running one. */
export async function startWorker(instance: FaultInstance): Promise<Service> {
  const service = spawnProcess('worker', instance, { API_PORT: String(freePort()) })
  // Give a failing start a moment to show itself, so the tests do not wait on something that exited.
  await Promise.race([
    service.exited.then(() => {
      throw new Error(`the worker exited while starting\n${service.logTail()}`)
    }),
    Bun.sleep(1_500),
  ])
  return service
}

// ───────── a client ─────────

export type Reply<T = unknown> = { status: number; body: T }

/** Talks to an API process like the browser does: cookies kept, the site's origin on every request. */
export class ApiClient {
  readonly jar = new Map<string, string>()
  readonly #baseUrl: string

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl
  }

  /** A client that is already signed in: the session of the cookie header, as another process of the site sees it. */
  static withCookie(baseUrl: string, cookie: string): ApiClient {
    const client = new ApiClient(baseUrl)
    for (const part of cookie.split('; ')) {
      const at = part.indexOf('=')
      if (at > 0) client.jar.set(part.slice(0, at), part.slice(at + 1))
    }
    return client
  }

  get cookie(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  async call<T = unknown>(
    path: string,
    init: { method?: string; json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Reply<T>> {
    const headers = new Headers(init.headers)
    headers.set('origin', FAULT_ORIGIN)
    if (init.json !== undefined) headers.set('content-type', 'application/json')
    if (this.jar.size > 0) headers.set('cookie', this.cookie)
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
    for (const line of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim())
      const at = pair.indexOf('=')
      const name = pair.slice(0, at)
      const value = pair.slice(at + 1)
      if (attributes.some((a) => /^max-age=0$/i.test(a)) || value === '') this.jar.delete(name)
      else this.jar.set(name, value)
    }
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T }
  }

  async signIn(email: string, password: string): Promise<void> {
    const reply = await this.call('/api/auth/sign-in/email', { json: { email, password } })
    if (reply.status !== 200) throw new Error(`sign-in answered ${reply.status}`)
  }
}
