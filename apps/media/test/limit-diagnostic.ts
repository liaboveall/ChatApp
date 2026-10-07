/** Fixed, container-only reproduction for native stream error classification. Never shipped in runtime. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaRequest } from '@chatapp/contracts/media'
import sharp from 'sharp'
import { processImage } from '../src/runtime/image.ts'
import { writeBoundedFile } from '../src/runtime/streams.ts'

sharp.concurrency(1)
sharp.cache(false)
function describe(error: unknown): Record<string, unknown> {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null
  const message = error instanceof Error ? error.message : ''
  return {
    name: error instanceof Error ? error.name : 'unknown',
    code: typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? code : null,
    messageClass: [
      'output_limit',
      'invalid_input',
      'media_cleanup_failed',
      'Premature close',
    ].includes(message)
      ? message
      : 'other',
  }
}

export async function runLimitDiagnostic(): Promise<void> {
  const bytes = await Bun.stdin.bytes()
  const directory = await mkdtemp('/tmp/m3-limit-')
  const request: MediaRequest = {
    v: 1,
    jobId: randomUUID(),
    generation: 1,
    nonce: '0'.repeat(64),
    operation: 'image',
    inputBytes: bytes.length,
    inputSha256: createHash('sha256').update(bytes).digest('hex'),
    maxOutputBytes: 16,
  }
  const evidence: Record<string, unknown> = {}
  try {
    await writeFile(join(directory, 'file-input'), bytes, { mode: 0o600 })
    try {
      await processImage(request, directory)
      evidence.processImage = 'unexpected_success'
    } catch (error) {
      evidence.processImage = describe(error)
    }
    await rm(join(directory, 'file-original'), { force: true })
    try {
      await writeBoundedFile(
        sharp(bytes).autoOrient().webp({ quality: 82, effort: 4 }),
        join(directory, 'file-original'),
        16,
      )
      evidence.boundedNativeStream = 'unexpected_success'
    } catch (error) {
      evidence.boundedNativeStream = describe(error)
    }
    console.info(JSON.stringify(evidence))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
