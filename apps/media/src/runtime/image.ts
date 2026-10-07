import { join } from 'node:path'
import {
  MEDIA_LIMITS,
  type MediaFile,
  type MediaRequest,
  type MediaSuccess,
  type MediaVariant,
  mediaIdentity,
} from '@chatapp/contracts/media'
import sharp, { type Metadata, type Sharp } from 'sharp'
import { rgbaToThumbHash } from 'thumbhash'
import {
  imageBounds,
  imageDecodeFailure,
  imageFormat,
  MediaError,
  outputName,
  TASK_FILES,
} from '../policy.ts'
import { filePrefix, inspectFile } from './files.ts'
import { writeBoundedFile } from './streams.ts'

sharp.concurrency(1)
sharp.cache(false)

const inputOptions = {
  animated: true,
  limitInputPixels: MEDIA_LIMITS.animatedPixels,
  limitInputChannels: 4,
  failOn: 'warning',
  sequentialRead: true,
  ignoreIcc: true,
} as const

function cleared(metadata: Metadata): boolean {
  return (
    !metadata.hasProfile &&
    metadata.orientation === undefined &&
    metadata.exif === undefined &&
    metadata.icc === undefined &&
    metadata.iptc === undefined &&
    metadata.xmp === undefined &&
    metadata.xmpAsString === undefined &&
    metadata.tifftagPhotoshop === undefined &&
    metadata.gainMap === undefined &&
    (metadata.comments?.length ?? 0) === 0
  )
}

function encode(pipeline: Sharp, animated: boolean): Sharp {
  // Sharp strips metadata by default. Never call keepMetadata/withMetadata/withExif here.
  return animated
    ? pipeline.gif({ effort: 3, keepDuplicateFrames: true })
    : pipeline.webp({ quality: 82, effort: 4 })
}

async function variant(
  directory: string,
  name: MediaVariant,
  pipeline: Sharp,
  animated: boolean,
  frames: number,
  limit: number,
): Promise<MediaFile> {
  const path = join(directory, outputName(name))
  try {
    await writeBoundedFile(encode(pipeline, animated).timeout({ seconds: 60 }), path, limit)
  } catch (error) {
    throw imageDecodeFailure(error)
  }
  const digest = await inspectFile(path, limit)
  let metadata: Metadata
  try {
    metadata = await sharp(path, inputOptions).metadata()
  } catch {
    throw new MediaError('processor_failed')
  }
  const bounds = imageBounds(metadata, animated ? 'gif' : 'webp')
  if (!cleared(metadata) || bounds.frames !== frames) throw new MediaError('processor_failed')
  return {
    variant: name,
    mime: animated ? 'image/gif' : 'image/webp',
    ...digest,
    width: bounds.width,
    height: bounds.height,
  }
}

export async function processImage(
  request: MediaRequest,
  directory: string,
): Promise<MediaSuccess> {
  const input = join(directory, TASK_FILES.input)
  const format = imageFormat(await filePrefix(input))
  if (!format) throw new MediaError('unsupported')
  let metadata: Metadata
  try {
    metadata = await sharp(input, inputOptions).metadata()
  } catch (error) {
    throw imageDecodeFailure(error)
  }
  const bounds = imageBounds(metadata, format)
  let originalPipeline = sharp(input, inputOptions).autoOrient().toColourspace('srgb')
  if (request.operation === 'avatar')
    originalPipeline = originalPipeline.resize({
      width: 256,
      height: 256,
      fit: 'cover',
      position: 'centre',
    })
  const original = await variant(
    directory,
    'original',
    originalPipeline,
    bounds.animated,
    bounds.frames,
    Math.min(request.maxOutputBytes, MEDIA_LIMITS.imageBytes),
  )
  if (
    original.width !== (request.operation === 'avatar' ? 256 : bounds.width) ||
    original.height !== (request.operation === 'avatar' ? 256 : bounds.height)
  )
    throw new MediaError('processor_failed')
  const source = join(directory, TASK_FILES.original)
  const files: MediaFile[] = [original]
  let remaining = MEDIA_LIMITS.variantBytes as number
  for (const [name, side] of [
    ['thumb', 320],
    ['preview', 1600],
  ] as const) {
    const pipeline = sharp(source, inputOptions).toColourspace('srgb').resize({
      width: side,
      height: side,
      fit: 'inside',
      withoutEnlargement: true,
    })
    const output = await variant(
      directory,
      name,
      pipeline,
      bounds.animated,
      bounds.frames,
      remaining,
    )
    remaining -= output.bytes
    files.push(output)
  }
  // This is the only pixel buffer: at most 100 × 100 × RGBA, never an encoded input/output file.
  const hashImage = await sharp(source, { ...inputOptions, animated: false, pages: 1 })
    .resize({ width: 100, height: 100, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = hashImage.info
  if (
    width < 1 ||
    height < 1 ||
    width > 100 ||
    height > 100 ||
    channels !== 4 ||
    hashImage.data.byteLength !== width * height * 4
  )
    throw new MediaError('processor_failed')
  const thumbhash = Buffer.from(rgbaToThumbHash(width, height, hashImage.data)).toString('base64')
  return {
    ...mediaIdentity(request),
    status: 'ok',
    kind: 'image',
    mime: original.mime,
    width: original.width,
    height: original.height,
    durationMs: null,
    metadataCleared: true,
    thumbhash,
    files,
  }
}
