import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  decodeMediaRequest,
  MEDIA_LIMITS,
  type MediaRequest,
  type MediaResponse,
  mediaIdentity,
  mediaResponseSchema,
} from '@chatapp/contracts/media'
import { failureCode, TASK_FILES, validateResult } from '../policy.ts'
import { assertTaskDirectory, closeFile, readSmallFile, verifyFile } from './files.ts'

async function main(): Promise<void> {
  const directory = process.argv[2]
  if (!directory || process.argv.length !== 3) {
    process.exitCode = 1
    return
  }
  let request: MediaRequest | undefined
  let response: MediaResponse
  try {
    await assertTaskDirectory(directory)
    request = decodeMediaRequest(
      await readSmallFile(join(directory, TASK_FILES.request), MEDIA_LIMITS.headerBytes),
    )
    const input = await verifyFile(
      join(directory, TASK_FILES.input),
      { bytes: request.inputBytes, sha256: request.inputSha256 },
      'invalid_input',
    )
    await closeFile(input)
    // Loading native decoders happens only in this disposable process, after request and file admission.
    response =
      request.operation === 'video'
        ? await (await import('./video.ts')).processVideo(request, directory)
        : await (await import('./image.ts')).processImage(request, directory)
    response = mediaResponseSchema.parse(response)
    validateResult(request, response)
  } catch (error) {
    if (!request) {
      process.exitCode = 1
      return
    }
    response = { ...mediaIdentity(request), status: 'failed', code: failureCode(error) }
  }
  try {
    const json = new TextEncoder().encode(JSON.stringify(response))
    if (json.byteLength > MEDIA_LIMITS.headerBytes) {
      process.exitCode = 1
      return
    }
    await writeFile(join(directory, TASK_FILES.result), json, { flag: 'wx', mode: 0o600 })
  } catch {
    process.exitCode = 1
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch {
    process.exitCode = 1
  }
}
