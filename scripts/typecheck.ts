/**
 * Type-checks the root scripts and every workspace package (apps/*, packages/*) with its own tsconfig.
 * A package without a tsconfig.json is an error, so a new package cannot silently skip the check.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const TSC = join('node_modules', '.bin', 'tsc')

/** tsconfig files to check: one per package, plus the few packages that hold code for another runtime (the service worker). */
const projects = ['tsconfig.json']
for (const group of ['apps', 'packages']) {
  if (!existsSync(group)) continue
  for (const entry of readdirSync(group, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(group, entry.name)
    if (!existsSync(join(dir, 'package.json'))) continue
    if (!existsSync(join(dir, 'tsconfig.json'))) {
      console.error(`${dir}: package has no tsconfig.json, so it would not be type-checked`)
      process.exit(1)
    }
    projects.push(join(dir, 'tsconfig.json'))
  }
}
// The service worker runs in a worker scope (no DOM): it has its own configuration (docs/03 section 11, M6).
projects.push(join('apps', 'web', 'tsconfig.sw.json'))

// The web package imports its translated texts from generated code; compile them first (a no-op when unchanged).
if (existsSync(join('apps', 'web', 'package.json'))) {
  const generate = Bun.spawn(['bun', 'run', '--cwd', 'apps/web', 'generate'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [, errors, code] = await Promise.all([
    new Response(generate.stdout).text(),
    new Response(generate.stderr).text(),
    generate.exited,
  ])
  if (code !== 0) {
    console.error(`apps/web: generating the translated texts failed\n${errors}`)
    process.exit(1)
  }
}

const results = await Promise.all(
  projects.map(async (dir) => {
    const proc = Bun.spawn([TSC, '-p', dir], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { dir, output: `${stdout}${stderr}`.trim(), code }
  }),
)

let failed = false
for (const { dir, output, code } of results) {
  if (code === 0) {
    console.log(`typecheck ok: ${dir}`)
    continue
  }
  failed = true
  console.error(`typecheck FAILED: ${dir}\n${output}`)
}
process.exit(failed ? 1 : 0)
