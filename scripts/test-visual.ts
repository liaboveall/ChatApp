#!/usr/bin/env bun
/**
 * Visual regression tests in the official Playwright Linux image (docs/08 section 2, L-08).
 *
 *   bun run test:visual                    compare against the committed baselines
 *   bun run test:visual -- --update-snapshots   (re)create them; review the changed PNGs before committing
 *
 * Builds Storybook on the host, then runs Playwright inside `mcr.microsoft.com/playwright:v<version>-noble` with the
 * repository mounted. The image tag follows the installed @playwright/test, because the browsers inside must match it.
 * Needs Docker (Docker Desktop must be running).
 */
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const web = await Bun.file(`${ROOT}apps/web/package.json`).json()
const version = String(web.devDependencies['@playwright/test']).replace(/^[^\d]*/, '')
const image = `mcr.microsoft.com/playwright:v${version}-noble`

async function run(command: string[], cwd = ROOT): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit' })
  const code = await child.exited
  if (code !== 0) process.exit(code)
}

console.log('building Storybook…')
await run(['bun', 'run', '--cwd', 'apps/web', 'storybook:build'])

const uid = process.getuid?.() ?? 1000
const gid = process.getgid?.() ?? 1000
console.log(`running Playwright in ${image}…`)
await run([
  'docker',
  'run',
  '--rm',
  '--ipc=host',
  '--user',
  `${uid}:${gid}`,
  '-e',
  'HOME=/tmp',
  '-v',
  `${ROOT}:/work`,
  '-w',
  '/work/apps/web',
  image,
  'npx',
  'playwright',
  'test',
  '-c',
  'playwright.visual.config.ts',
  ...process.argv.slice(2).filter((arg) => arg !== '--'),
])
