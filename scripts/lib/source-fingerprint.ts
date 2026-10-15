/** Non-secret source binding for an uncommitted recovery experiment. Excludes configuration and generated/runtime data. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
export async function recoverySourceFingerprint(): Promise<string> {
  const listed = Bun.spawn(
    [
      'rg',
      '--files',
      'apps/server',
      'packages',
      'scripts',
      '-g',
      '*.ts',
      '-g',
      '*.sql',
      '-g',
      '*.json',
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const files = (await new Response(listed.stdout).text()).trim().split('\n').filter(Boolean).sort()
  if ((await listed.exited) !== 0 || !files.length) throw new Error('source inventory unavailable')
  const hash = createHash('sha256')
  for (const path of [...files, 'bun.lock', 'package.json']) {
    hash.update(path)
    hash.update('\0')
    hash.update(await readFile(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}
