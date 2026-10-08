import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const manifestSchema = z.object({
  version: z.string(),
  dimension: z.number(),
  revision: z.string(),
  dtype: z.literal('q8'),
  totalBytes: z.number().positive().max(1_500_000_000),
  files: z
    .array(
      z.object({
        path: z.string(),
        bytes: z.number().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .nonempty(),
})
export async function verifyEmbeddingFiles(
  directory: string,
  model: { version: string; dimension: number; revision: string },
) {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, 'chatapp-model-manifest.json'), 'utf8')),
  )
  if (
    manifest.version !== model.version ||
    manifest.dimension !== model.dimension ||
    manifest.revision !== model.revision ||
    manifest.files.reduce((n, f) => n + f.bytes, 0) !== manifest.totalBytes
  )
    throw new Error('Local model manifest mismatch; run explicit model preparation')
  for (const file of manifest.files) {
    if (file.path.startsWith('/') || file.path.split(/[\\/]/).includes('..'))
      throw new Error('Invalid model manifest path')
    const path = join(directory, file.path)
    if ((await stat(path)).size !== file.bytes) throw new Error('Local model file length mismatch')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest('hex') !== file.sha256) throw new Error('Local model file checksum mismatch')
  }
  return manifest.totalBytes
}
