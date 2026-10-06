/**
 * The host ports of the local infrastructure, and what can make one of them silently unusable (D-172).
 *
 * Docker Desktop publishes container ports on the Windows host. Windows keeps lists of TCP port ranges that no program may
 * bind: blocks of 100 that Hyper-V and WinNAT take out of the *dynamic* port range (here 1024–15000; the system default is
 * 49152–65535), and different ones after every restart. A port inside such a block is not an error for Docker: the
 * container starts, passes its health check, and the port is just not there (`docker port` prints nothing). Ports above
 * the dynamic range are never taken by those reservations, so the defaults are there (the usual port plus 20000).
 *
 * Everything here is plain functions on plain data except the two readers of the Windows lists (`netsh.exe`, reachable from
 * WSL only: anywhere else they answer null and the checks that need them are skipped) and `reachable`.
 */

export type PortRange = { start: number; end: number }

/** What Windows says about TCP ports: the ranges nobody may bind, and the range its own reservations are drawn from. */
export type WindowsPorts = { excluded: PortRange[]; dynamic: PortRange | null }

/** The defaults of `.env.example` and of `infra/compose.dev.yml` (a test keeps the two in step). */
export const DEFAULT_POSTGRES_PORT = 25434
export const DEFAULT_VALKEY_PORT = 26379
export const DEFAULT_SMTP_PORT = 2525

// ───────── What Windows reserves ─────────

/** The ranges of `netsh interface ipv4 show excludedportrange protocol=tcp`: any language, only the two numbers of a line count. */
export function parseExcludedRanges(output: string): PortRange[] {
  const ranges: PortRange[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d{1,5})\s+(\d{1,5})(?:\s|\*|$)/.exec(line)
    if (match === null) continue
    const start = Number(match[1])
    const end = Number(match[2])
    if (start <= end) ranges.push({ start, end })
  }
  return ranges
}

/** The range of `netsh int ipv4 show dynamicport tcp`: a start and a count, each after a colon, whatever the language. */
export function parseDynamicRange(output: string): PortRange | null {
  const numbers = [...output.matchAll(/:\s*(\d+)/g)].map((match) => Number(match[1]))
  const [start, count] = numbers
  return start !== undefined && count !== undefined && count > 0
    ? { start, end: start + count - 1 }
    : null
}

export const inRanges = (port: number, ranges: readonly PortRange[]): PortRange | undefined =>
  ranges.find((range) => port >= range.start && port <= range.end)

const NETSH_EXCLUDED = ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp']
const NETSH_DYNAMIC = ['int', 'ipv4', 'show', 'dynamicport', 'tcp']

/** The Windows lists, or null when this is not a WSL that can run `netsh.exe`. */
export async function windowsPorts(): Promise<WindowsPorts | null> {
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const child = Bun.spawn(['netsh.exe', ...args], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      })
      const text = await new Response(child.stdout).text()
      return (await child.exited) === 0 ? text : null
    } catch {
      return null
    }
  }
  const excluded = await run(NETSH_EXCLUDED)
  if (excluded === null) return null
  const dynamic = await run(NETSH_DYNAMIC)
  return {
    excluded: parseExcludedRanges(excluded),
    dynamic: dynamic === null ? null : parseDynamicRange(dynamic),
  }
}

/** The same, for code that cannot wait (picking ports for a throw-away instance). */
export function windowsPortsSync(): WindowsPorts | null {
  const run = (args: string[]): string | null => {
    try {
      const done = Bun.spawnSync(['netsh.exe', ...args], { stdin: 'ignore', stderr: 'ignore' })
      return done.exitCode === 0 ? done.stdout.toString() : null
    } catch {
      return null
    }
  }
  const excluded = run(NETSH_EXCLUDED)
  if (excluded === null) return null
  const dynamic = run(NETSH_DYNAMIC)
  return {
    excluded: parseExcludedRanges(excluded),
    dynamic: dynamic === null ? null : parseDynamicRange(dynamic),
  }
}

/** Whether Windows keeps this port from being bound now. */
export const isReserved = (port: number, windows: WindowsPorts | null): PortRange | undefined =>
  windows === null ? undefined : inRanges(port, windows.excluded)

/**
 * A port to move to: the first from `from` upward that is above the dynamic range and outside every excluded range (nothing
 * reserves such a port), and that is none of `taken`.
 */
export function suggestPort(
  from: number,
  windows: WindowsPorts | null,
  taken: readonly number[],
): number {
  for (let port = Math.max(from, 1024); port <= 65535; port += 1) {
    if (taken.includes(port)) continue
    if (isReserved(port, windows) !== undefined) continue
    if (windows?.dynamic != null && inRanges(port, [windows.dynamic]) !== undefined) continue
    return port
  }
  throw new Error('no usable port above the dynamic range')
}

// ───────── The ports of the infrastructure ─────────

export type InfraPort = {
  /** What the person reads: the variable that sets it, or the service and its role. */
  name: string
  port: number
  /** The compose service and the port inside its container, to look the publication up. */
  service: string
  target: number
  /** The `.env.local` variable that moves it; absent when the compose file fixes it. */
  variable?: string
}

/** The host ports `infra/compose.dev.yml` publishes, from the values of `.env.local` (a missing one has the compose default). */
export function infraPorts(read: (key: string) => string | undefined): InfraPort[] {
  const number = (key: string, fallback: number): number => {
    const value = Number(read(key))
    return Number.isInteger(value) && value > 0 ? value : fallback
  }
  return [
    {
      name: 'POSTGRES_PORT',
      port: number('POSTGRES_PORT', DEFAULT_POSTGRES_PORT),
      service: 'postgres',
      target: 5432,
      variable: 'POSTGRES_PORT',
    },
    {
      name: 'VALKEY_PORT',
      port: number('VALKEY_PORT', DEFAULT_VALKEY_PORT),
      service: 'valkey',
      target: 6379,
      variable: 'VALKEY_PORT',
    },
    { name: 'Garage S3', port: 3900, service: 'garage', target: 3900 },
    { name: 'Garage admin', port: 3903, service: 'garage', target: 3903 },
    {
      name: 'SMTP_PORT',
      port: number('SMTP_PORT', DEFAULT_SMTP_PORT),
      service: 'mailpit',
      target: 1025,
      variable: 'SMTP_PORT',
    },
    { name: 'Mailpit web', port: 8025, service: 'mailpit', target: 8025 },
  ]
}

// ───────── Ports inside the connection URLs ─────────

/** The URLs of `.env.local` that carry a port of the infrastructure, with the variable that sets it. */
export const URL_PORTS: ReadonlyArray<{ url: string; variable: string }> = [
  { url: 'DATABASE_OWNER_URL', variable: 'POSTGRES_PORT' },
  { url: 'DATABASE_OWNER_URL_TEST', variable: 'POSTGRES_PORT' },
  { url: 'DATABASE_URL', variable: 'POSTGRES_PORT' },
  { url: 'DATABASE_URL_TEST', variable: 'POSTGRES_PORT' },
  { url: 'VALKEY_URL', variable: 'VALKEY_PORT' },
  { url: 'VALKEY_URL_TEST', variable: 'VALKEY_PORT' },
]

export function portOf(url: string): number | undefined {
  try {
    const port = Number(new URL(url).port)
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

/** The same URL with another host port (user, password, database and the rest stay as they are). */
export function withPort(url: string, port: number): string {
  const parsed = new URL(url)
  parsed.port = String(port)
  return parsed.toString()
}

// ───────── Problems, in words that say what to do ─────────

/** Where the search for a port to move to starts, per variable: the usual port plus 20000. */
const MOVE_FROM: Record<string, number> = {
  POSTGRES_PORT: DEFAULT_POSTGRES_PORT,
  VALKEY_PORT: DEFAULT_VALKEY_PORT,
  SMTP_PORT: 22_525,
}

const SETUP_HINT =
  'run `bun run setup` (it rewrites the ports in the connection URLs), then `bun run infra:up`'

function moveAdvice(
  port: InfraPort,
  windows: WindowsPorts | null,
  plan: readonly InfraPort[],
): string {
  if (port.variable === undefined) {
    return `Nothing in .env.local moves it: it is fixed in infra/compose.dev.yml${port.service === 'garage' ? ' (and S3_ENDPOINT)' : ''}.`
  }
  const suggestion = suggestPort(
    MOVE_FROM[port.variable] ?? 20_000,
    windows,
    plan.map((entry) => entry.port),
  )
  return `Set ${port.variable}=${suggestion} in .env.local, ${SETUP_HINT}.`
}

/** The ports Windows has reserved right now: Docker Desktop cannot publish them, and says nothing. */
export function reservedProblems(
  plan: readonly InfraPort[],
  windows: WindowsPorts | null,
): string[] {
  const problems: string[] = []
  for (const port of plan) {
    const range = isReserved(port.port, windows)
    if (range === undefined) continue
    problems.push(
      `host port ${port.port} (${port.name}) is inside a range Windows has reserved (${range.start}-${range.end}): Docker Desktop cannot publish it and does not say so. ${moveAdvice(port, windows, plan)}`,
    )
  }
  return problems
}

/** Ports in connection URLs that differ from the variable that sets the published port: one line per variable and port. */
export function urlProblems(
  read: (key: string) => string | undefined,
  plan: readonly InfraPort[],
): string[] {
  const groups = new Map<
    string,
    { variable: string; actual: number; wanted: number; urls: string[] }
  >()
  for (const { url, variable } of URL_PORTS) {
    const value = read(url)
    const wanted = plan.find((entry) => entry.variable === variable)?.port
    const actual = value === undefined ? undefined : portOf(value)
    if (wanted === undefined || actual === undefined || actual === wanted) continue
    const key = `${variable}:${actual}`
    const group = groups.get(key) ?? { variable, actual, wanted, urls: [] }
    group.urls.push(url)
    groups.set(key, group)
  }
  return [...groups.values()].map(
    ({ variable, actual, wanted, urls }) =>
      `${urls.join(', ')} ${urls.length === 1 ? 'uses' : 'use'} port ${actual} but ${variable} is ${wanted}: ${SETUP_HINT}.`,
  )
}

// ───────── What compose says is published ─────────

export type ComposeRow = {
  Service: string
  State?: string
  Health?: string
  /** Present in every row of `docker compose ps --format json`; absent only in an engine that does not say. */
  Publishers?: Array<{ URL?: string; TargetPort: number; PublishedPort: number }> | null
}

/** The rows of `docker compose ps --format json`: a JSON array in some versions, one object per line in others. */
export function parseComposePs(raw: string): ComposeRow[] {
  const text = raw.trim()
  if (text === '') return []
  if (text.startsWith('[')) return JSON.parse(text) as ComposeRow[]
  return text
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as ComposeRow)
}

/** Ports a running service should publish and does not: the container is there, the port is not. */
export function publishedProblems(
  rows: readonly ComposeRow[],
  plan: readonly InfraPort[],
): string[] {
  const problems: string[] = []
  for (const port of plan) {
    const row = rows.find((candidate) => candidate.Service === port.service)
    if (row === undefined || row.State !== 'running' || row.Publishers === undefined) continue
    const published = (row.Publishers ?? []).filter(
      (entry) => entry.TargetPort === port.target && entry.PublishedPort > 0,
    )
    if (published.some((entry) => entry.PublishedPort === port.port)) continue
    const other = published[0]
    problems.push(
      other === undefined
        ? `${port.service} is running but host port ${port.port} (${port.name}) is not published: Docker Desktop could not bind it, and a range Windows reserved (\`netsh interface ipv4 show excludedportrange protocol=tcp\`) is the usual cause.`
        : `${port.service} publishes host port ${other.PublishedPort} but ${port.name} says ${port.port}: ${SETUP_HINT}.`,
    )
  }
  return problems
}

// ───────── Does anything answer ─────────

/** Whether a TCP connection to the loopback port opens within the time. */
export async function reachable(port: number, timeoutMs = 2000): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    const done = (answer: boolean): void => {
      clearTimeout(timer)
      resolve(answer)
    }
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.end()
          done(true)
        },
        data() {},
        error() {
          done(false)
        },
        connectError() {
          done(false)
        },
      },
    }).catch(() => done(false))
  })
}

/** Waits for the port to answer: the Windows side that forwards a new listener into WSL needs a moment. */
export async function waitReachable(port: number, totalMs = 10_000): Promise<boolean> {
  const until = Date.now() + totalMs
  for (;;) {
    if (await reachable(port, 1000)) return true
    if (Date.now() >= until) return false
    await Bun.sleep(500)
  }
}
