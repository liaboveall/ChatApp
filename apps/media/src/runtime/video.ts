import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MEDIA_LIMITS,
  type MediaRequest,
  type MediaSuccess,
  mediaIdentity,
} from '@chatapp/contracts/media'
import {
  cleanVideoFacts,
  MediaError,
  probeArgs,
  remuxArgs,
  TASK_FILES,
  videoDemuxer,
  videoFacts,
} from '../policy.ts'
import { closeFile, filePrefix, inspectFile, openRegular } from './files.ts'
import { writeBoundedFile } from './streams.ts'
import { probe, remux } from './tools.ts'

export async function processVideo(
  request: MediaRequest,
  directory: string,
): Promise<MediaSuccess> {
  const input = join(directory, TASK_FILES.input)
  const output = join(directory, TASK_FILES.original)
  const demuxer = videoDemuxer(await filePrefix(input))
  if (!demuxer) throw new MediaError('unsupported')
  const facts = videoFacts(await probe(probeArgs(input, demuxer), directory), demuxer)
  const limit = Math.min(request.maxOutputBytes, MEDIA_LIMITS.inputBytes)
  try {
    await remux(remuxArgs(input, demuxer), directory, output, limit)
    const cleaned = cleanVideoFacts(await probe(probeArgs(output, 'mov'), directory), facts)
    const digest = await inspectFile(output, limit)
    return {
      ...mediaIdentity(request),
      status: 'ok',
      kind: 'video',
      mime: 'video/mp4',
      width: cleaned.width,
      height: cleaned.height,
      durationMs: cleaned.durationMs,
      metadataCleared: true,
      thumbhash: null,
      files: [
        {
          variant: 'original',
          mime: 'video/mp4',
          ...digest,
          width: cleaned.width,
          height: cleaned.height,
        },
      ],
    }
  } catch {
    // Unknown or remaining metadata is never claimed clean or made playable inline.
    await rm(output, { force: true })
    if (request.inputBytes > limit) throw new MediaError('output_limit')
    const raw = await openRegular(input, request.inputBytes, 'invalid_input')
    try {
      await writeBoundedFile(
        createReadStream(input, { fd: raw.fd, autoClose: false }),
        output,
        limit,
      )
    } finally {
      await closeFile(raw)
    }
    const digest = await inspectFile(output, limit)
    if (digest.bytes !== request.inputBytes || digest.sha256 !== request.inputSha256)
      throw new MediaError('invalid_input')
    return {
      ...mediaIdentity(request),
      status: 'ok',
      kind: 'file',
      mime: 'application/octet-stream',
      width: null,
      height: null,
      durationMs: null,
      metadataCleared: false,
      thumbhash: null,
      files: [
        {
          variant: 'original',
          mime: 'application/octet-stream',
          ...digest,
          width: null,
          height: null,
        },
      ],
    }
  }
}
