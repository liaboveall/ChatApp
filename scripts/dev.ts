#!/usr/bin/env bun
/**
 * `bun run dev`: the API, the worker and the web dev server together, with prefixed output. Needs `bun run infra:up`.
 *
 *   bun run dev                  API, worker, web; also embeddings when EMBEDDING_ENABLED=true
 *                                uses a checked localhost port; if Windows reserves 5173, normally uses 25174 instead
 *   bun run dev -- api web       only the named ones (api, worker, web, embeddings, pwa)
 *   bun run dev -- api worker pwa
 *                                the production build instead of the dev server, at http://localhost:25173 (M6): only a build
 *                                has the service worker, so this is how the app is installed and real pushes are tried on
 *                                this machine (docs/08 section 10). Its own port keeps the worker away from the dev server's
 *                                origin; the API started with it takes that origin. Restart it to rebuild.
 *
 * The worker runs through the fixed worker/media Compose topology (M3, D-081), never on the host.
 * Ctrl+C stops child processes and only the containers this invocation created; a verified existing stack is reused.
 * If one process dies the others are stopped too, and the exit code is non-zero.
 */
import { developmentSite } from './lib/dev-site.ts'
import { getEnv, readEnvFile } from './lib/env-file.ts'
import { windowsPorts } from './lib/ports.ts'

const COMMANDS: Record<string, string[]> = {
  api: ['bun', '--env-file=.env.local', '--watch', 'apps/server/src/api.ts'],
  worker: ['bun', '--env-file=.env.local', 'scripts/media.ts', 'run'],
  web: ['bun', 'run', '--cwd', 'apps/web', 'dev'],
  embeddings: ['bun', '--env-file=.env.local', 'apps/server/src/runtime/embedding-worker.ts'],
  pwa: [], // Filled with the checked localhost port before any children start.
}
const COLORS: Record<string, string> = {
  api: '\x1b[36m',
  worker: '\x1b[35m',
  web: '\x1b[33m',
  embeddings: '\x1b[32m',
  pwa: '\x1b[33m',
}

const wanted = process.argv.slice(2).filter((arg) => arg !== '--')
const embeddingEnabled = getEnv(await readEnvFile('.env.local'), 'EMBEDDING_ENABLED') === 'true'
const names =
  wanted.length > 0 ? wanted : ['api', 'worker', 'web', ...(embeddingEnabled ? ['embeddings'] : [])]
for (const name of names) {
  if (!Object.hasOwn(COMMANDS, name)) {
    console.error(`unknown process "${name}"; choose from ${Object.keys(COMMANDS).join(', ')}`)
    process.exit(2)
  }
}
// The API accepts one origin (APP_ORIGIN): the dev server's, or the build's on its own port.
if (names.includes('web') && names.includes('pwa')) {
  console.error('choose "web" or "pwa", not both: the API accepts requests from one origin')
  process.exit(2)
}
const mode = names.includes('pwa') ? 'pwa' : names.includes('web') ? 'web' : null
const site = mode ? developmentSite(mode, await windowsPorts()) : null
if (site) {
  if (site.reservation) {
    console.warn(
      `[dev] Windows reserves ${site.reservation.start}-${site.reservation.end}; port ${site.requested} cannot be forwarded. Using ${site.origin}`,
    )
  }
  console.log(`[dev] Open ${site.origin} (${mode})`)
  if (mode === 'web') COMMANDS.web?.push('--port', String(site.port))
  else {
    COMMANDS.pwa = [
      'sh',
      '-c',
      // `exec`: the stop signal reaches the preview instead of stopping only its shell.
      `bun run --cwd apps/web build && exec bun run --cwd apps/web preview --port ${site.port}`,
    ]
  }
}

async function pipe(name: string, stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) {
  const decoder = new TextDecoder()
  let pending = ''
  const label = `${COLORS[name] ?? ''}[${name}]\x1b[0m`
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) target.write(`${label} ${line}\n`)
  }
  if (pending) target.write(`${label} ${pending}\n`)
}

const children = names.map((name) => {
  const child = Bun.spawn(COMMANDS[name] as string[], {
    // The API and every worker must agree on the browser origin (authorization, mail links and push subscriptions).
    env: { ...process.env, ...(site ? { APP_ORIGIN: site.origin } : {}) },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  void pipe(name, child.stdout, process.stdout)
  void pipe(name, child.stderr, process.stderr)
  return { name, child }
})

let stopping = false
const stop = (): void => {
  stopping = true
  for (const { child } of children) child.kill('SIGTERM')
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

const first = await Promise.race(
  children.map(async ({ name, child }) => ({ name, code: await child.exited })),
)
if (!stopping)
  console.error(`\n[dev] ${first.name} exited with code ${first.code}; stopping the others`)
stop()
await Promise.all(children.map(({ child }) => child.exited))
process.exit(stopping && first.code === 0 ? 0 : first.code || 1)
