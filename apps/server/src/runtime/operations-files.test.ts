import { afterEach, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { postgresEnvironment, privateJson, runPrivate } from './operations-files.ts'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
test('private operator input rejects symlinks and public permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatapp-ops-'))
  directories.push(directory)
  const path = join(directory, 'input.json')
  await writeFile(path, '{"value":1}', { mode: 0o644 })
  await chmod(path, 0o644)
  await expect(privateJson(path, z.object({ value: z.number() }))).rejects.toThrow('private file')
  await symlink(path, join(directory, 'link.json'))
  await expect(
    privateJson(join(directory, 'link.json'), z.object({ value: z.number() })),
  ).rejects.toThrow('private file')
})
test('PostgreSQL passwords stay in the child environment; unrelated application credentials are not inherited', async () => {
  const env = postgresEnvironment(
    'postgres://operator:public-test-password@localhost:5432/test?sslmode=require',
  )
  expect(env.PGPASSWORD).toBe('public-test-password')
  expect(env.PGSSLMODE).toBe('require')
  await expect(
    runPrivate([
      process.execPath,
      '--no-env-file',
      '-e',
      'process.stderr.write("public-test-diagnostic");process.exit(1)',
    ]),
  ).rejects.toThrow('operator subprocess failed')
  const output = await runPrivate([
    process.execPath,
    '--no-env-file',
    '-e',
    'process.stdout.write(JSON.stringify(Object.keys(process.env).filter(name=>name.startsWith("SOCLAAS")||name.startsWith("DATABASE")||name.startsWith("BETTER_AUTH"))))',
  ])
  expect(JSON.parse(output)).toEqual([])
  expect(() => postgresEnvironment('https://example.invalid')).toThrow()
})
