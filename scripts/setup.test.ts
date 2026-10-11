import { expect, test } from 'bun:test'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('fresh setup makes a loadable push configuration and repeated setup preserves every value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatapp-setup-'))
  try {
    await mkdir(join(directory, 'infra/garage'), { recursive: true })
    await copyFile(join(root, '.env.example'), join(directory, '.env.example'))
    await copyFile(
      join(root, 'infra/garage/garage.toml.template'),
      join(directory, 'infra/garage/garage.toml.template'),
    )
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, ...args], {
        cwd: directory,
        // The real local configuration must not mask the generated file, or be passed to this isolated process.
        env: { PATH: process.env.PATH ?? '' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      return { code, stdout, stderr }
    }
    const first = await run([join(root, 'scripts/setup.ts')])
    expect(first.code).toBe(0)
    const generated = await readFile(join(directory, '.env.local'), 'utf8')
    // Load with Bun's real env-file precedence, then the production config parser; no secret is returned to the test log.
    const loaded = await run([
      '--env-file=.env.local',
      '-e',
      `import { loadConfig } from ${JSON.stringify(join(root, 'apps/server/src/config/env.ts'))}; const config = loadConfig(process.env); console.log(JSON.stringify({ pushConfigured: config.push !== undefined }))`,
    ])
    expect(loaded.code).toBe(0)
    expect(JSON.parse(loaded.stdout)).toEqual({ pushConfigured: true })
    const second = await run([join(root, 'scripts/setup.ts')])
    expect(second.code).toBe(0)
    // Compare only a boolean: a failing test must not reproduce the generated configuration values.
    expect((await readFile(join(directory, '.env.local'), 'utf8')) === generated).toBe(true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
