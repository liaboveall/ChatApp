import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const sourceDigest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
/** An archive has a content manifest but no Git checkout; never invent a commit for its dirty source. */
export function evaluationGitRevision(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}
/** Includes untracked implementation files. Dirty working trees need content evidence beyond their base Git SHA. */
export async function evaluationSourceManifest() {
  const entries: { path: string; sha256: string }[] = []
  for (const root of [
    'apps/server/src',
    'packages/contracts/src',
    'packages/db/src',
    'packages/db/drizzle',
    'apps/server/evals',
  ]) {
    for (const file of await readdir(root, { recursive: true })) {
      if (
        !/\.(ts|sql)$/.test(file) ||
        /(?:^|\/)(?:results|corpus|cases)(?:\/|$)|\.test\.ts$/.test(file)
      )
        continue
      const path = join(root, file)
      entries.push({ path, sha256: sourceDigest(await readFile(path)) })
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}
