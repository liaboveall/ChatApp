#!/usr/bin/env bun
/**
 * `bun run dev`: the API, the worker and the web dev server together, with prefixed output. Needs `bun run infra:up`.
 *
 *   bun run dev                  all three
 *   bun run dev -- api web       only the named ones (api, worker, web)
 *
 * The worker runs through the fixed worker/media Compose topology (M3, D-081), never on the host.
 * Ctrl+C stops child processes and only the containers this invocation created; a verified existing stack is reused.
 * If one process dies the others are stopped too, and the exit code is non-zero.
 */
const COMMANDS: Record<string, string[]> = {
  api: ['bun', '--env-file=.env.local', '--watch', 'apps/server/src/api.ts'],
  worker: ['bun', '--env-file=.env.local', 'scripts/media.ts', 'run'],
  web: ['bun', 'run', '--cwd', 'apps/web', 'dev'],
}
const COLORS: Record<string, string> = { api: '\x1b[36m', worker: '\x1b[35m', web: '\x1b[33m' }

const wanted = process.argv.slice(2).filter((arg) => arg !== '--')
const names = wanted.length > 0 ? wanted : Object.keys(COMMANDS)
for (const name of names) {
  if (!(name in COMMANDS)) {
    console.error(`unknown process "${name}"; choose from ${Object.keys(COMMANDS).join(', ')}`)
    process.exit(2)
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
