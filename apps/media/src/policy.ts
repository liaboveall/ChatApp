import {
  MEDIA_LIMITS,
  type MediaFailureCode,
  type MediaRequest,
  type MediaResponse,
  type MediaVariant,
} from '@chatapp/contracts/media'
import type { MediaProbe, MediaProbeStream } from '@chatapp/contracts/media-probe'

export const TASK_FILES = {
  input: 'file-input',
  request: 'request.json',
  result: 'result.json',
  original: 'file-original',
  thumb: 'file-thumb',
  preview: 'file-preview',
} as const

export class MediaError extends Error {
  constructor(readonly code: MediaFailureCode) {
    super(code)
    this.name = 'MediaError'
  }
}

export function failureCode(error: unknown): MediaFailureCode {
  return error instanceof MediaError ? error.code : 'processor_failed'
}

export function imageDecodeFailure(error: unknown): MediaError {
  if (error instanceof MediaError) return error
  // libvips can reject at its own pixel gate before metadata is available to our policy.
  return new MediaError(
    error instanceof Error && error.message.includes('Input image exceeds pixel limit')
      ? 'input_limit'
      : 'invalid_input',
  )
}

export function outputName(variant: MediaVariant): string {
  return TASK_FILES[variant]
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  return [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0))
}

function isoBrands(bytes: Uint8Array): string[] {
  if (bytes.byteLength < 16 || !ascii(bytes, 4, 'ftyp')) return []
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
  if (size < 16 || size % 4 !== 0) return []
  const brands: string[] = []
  for (let offset = 8; offset + 4 <= Math.min(size, bytes.byteLength); offset += 4) {
    if (offset === 12) continue
    brands.push(String.fromCharCode(...bytes.subarray(offset, offset + 4)))
  }
  return brands
}

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'avif'

/** A raster-only gate before libvips can select any decoder (not even SVG metadata parsing). */
export function imageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes[0] === 0x89 && ascii(bytes, 1, 'PNG\r\n\u001a\n')) return 'png'
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'gif'
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp'
  if (isoBrands(bytes).some((brand) => brand === 'avif' || brand === 'avis')) return 'avif'
  return null
}

export type ImageMetadata = {
  format: string
  width: number
  height: number
  pages?: number
  pageHeight?: number
  orientation?: number
  compression?: string
}

export type ImageBounds = { width: number; height: number; frames: number; animated: boolean }

export function imageBounds(metadata: ImageMetadata, format: ImageFormat): ImageBounds {
  if (
    metadata.format !== (format === 'avif' ? 'heif' : format) ||
    (format === 'avif' && metadata.compression !== 'av1')
  )
    throw new MediaError('unsupported')
  const frames = metadata.pages ?? 1
  const height = frames > 1 ? metadata.pageHeight : metadata.height
  if (
    !Number.isSafeInteger(frames) ||
    frames < 1 ||
    !Number.isSafeInteger(metadata.width) ||
    metadata.width < 1 ||
    height === undefined ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isSafeInteger(metadata.height) ||
    metadata.height < 1 ||
    (frames > 1 && metadata.height !== height && metadata.height !== height * frames) ||
    (metadata.orientation !== undefined &&
      (!Number.isInteger(metadata.orientation) ||
        metadata.orientation < 1 ||
        metadata.orientation > 8))
  )
    throw new MediaError('invalid_input')
  const pixels = metadata.width * height * frames
  if (
    frames > MEDIA_LIMITS.frames ||
    metadata.width > MEDIA_LIMITS.maxSide ||
    height > MEDIA_LIMITS.maxSide ||
    pixels > (frames > 1 ? MEDIA_LIMITS.animatedPixels : MEDIA_LIMITS.staticPixels)
  )
    throw new MediaError('input_limit')
  const rotated = (metadata.orientation ?? 1) >= 5
  return {
    width: rotated ? height : metadata.width,
    height: rotated ? metadata.width : height,
    frames,
    animated: frames > 1,
  }
}

export type VideoDemuxer = 'mov' | 'matroska' | 'avi'

export function videoDemuxer(bytes: Uint8Array): VideoDemuxer | null {
  const brands = isoBrands(bytes)
  if (brands.length > 0 && !brands.some((brand) => brand === 'avif' || brand === 'avis'))
    return 'mov'
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)
    return 'matroska'
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'AVI ')) return 'avi'
  return null
}

const PROBE_ENTRIES = [
  'format=format_name,duration',
  'format_tags',
  'stream=index,codec_type,codec_name,width,height,duration',
  'stream_tags',
  'stream_disposition=attached_pic',
  'stream_side_data=side_data_type,rotation',
  'chapter=id',
  'chapter_tags',
].join(':')

function videoInputArgs(input: string, demuxer: VideoDemuxer): string[] {
  return [
    '-protocol_whitelist',
    'file,pipe',
    '-format_whitelist',
    'mov,matroska,webm,avi',
    '-probesize',
    '1048576',
    '-analyzeduration',
    '5000000',
    ...(demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0'] : []),
    '-f',
    demuxer,
    '-i',
    input,
  ]
}

export function probeArgs(input: string, demuxer: VideoDemuxer): string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    '-max_alloc',
    '67108864',
    ...videoInputArgs(input, demuxer),
    '-show_entries',
    PROBE_ENTRIES,
    '-of',
    'json',
  ]
}

/** Fragmented MP4 allows a bounded stdout stream; -fs would silently truncate a successful remux. */
export function remuxArgs(input: string, demuxer: VideoDemuxer): string[] {
  return [
    '-hide_banner',
    '-v',
    'error',
    '-nostdin',
    '-max_alloc',
    '67108864',
    '-threads',
    '1',
    ...videoInputArgs(input, demuxer),
    '-map',
    '0:V:0',
    '-map',
    '0:a:0?',
    '-sn',
    '-dn',
    '-c',
    'copy',
    '-threads',
    '1',
    '-map_metadata',
    '-1',
    '-map_metadata:s',
    '-1',
    '-map_chapters',
    '-1',
    '-metadata',
    'encoder=',
    '-metadata:s',
    'encoder=',
    '-metadata:s:v:0',
    'handler_name=',
    '-metadata:s:a:0',
    'handler_name=',
    '-metadata:s:v:0',
    'rotate=',
    '-fflags',
    '+bitexact',
    '-brand',
    'mp42',
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1',
  ]
}

function probeDuration(value: string | undefined): number | null {
  if (value === undefined || value === 'N/A') return null
  const milliseconds = Math.ceil(Number(value) * 1000)
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new MediaError('invalid_input')
  if (milliseconds > MEDIA_LIMITS.durationMs) throw new MediaError('input_limit')
  return milliseconds
}

export type VideoFacts = {
  width: number
  height: number
  durationMs: number
  video: MediaProbeStream
  audio: MediaProbeStream | undefined
}

export function videoFacts(probe: MediaProbe, demuxer: VideoDemuxer): VideoFacts {
  const expected = {
    mov: 'mov,mp4,m4a,3gp,3g2,mj2',
    matroska: 'matroska,webm',
    avi: 'avi',
  } as const
  if (probe.format.format_name !== expected[demuxer]) throw new MediaError('unsupported')
  const video = probe.streams.find(
    (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  )
  if (!video?.codec_name) throw new MediaError('unsupported')
  const { width, height } = video
  if (width === undefined || height === undefined || width < 1 || height < 1)
    throw new MediaError('invalid_input')
  if (width > MEDIA_LIMITS.maxSide || height > MEDIA_LIMITS.maxSide)
    throw new MediaError('input_limit')
  // Check every track's known duration, not only the first video track or container duration.
  const durations = [
    probeDuration(probe.format.duration),
    ...probe.streams.map((stream) => probeDuration(stream.duration)),
  ]
  if (probeDuration(probe.format.duration) === null && probeDuration(video.duration) === null)
    throw new MediaError('unsupported')
  const durationMs = Math.max(
    ...durations.filter((duration): duration is number => duration !== null),
  )
  return {
    width,
    height,
    durationMs,
    video,
    audio: probe.streams.find((stream) => stream.codec_type === 'audio'),
  }
}

function cleanFormatTag(key: string, value: string): boolean {
  if (key === 'major_brand') return value === 'mp42'
  if (key === 'minor_version') return /^\d{1,10}$/.test(value)
  if (key === 'compatible_brands')
    return (
      /^(?:mp42|isom|iso2|iso5|iso6|avc1|mp41|hvc1|hev1|av01)+$/.test(value) && value.length <= 64
    )
  return false
}

function cleanStreamTag(stream: MediaProbeStream, key: string, value: string): boolean {
  if (key === 'language') return value === 'und'
  if (key === 'vendor_id') return value === '[0][0][0][0]'
  if (key === 'handler_name')
    return (
      value === '' || value === (stream.codec_type === 'video' ? 'VideoHandler' : 'SoundHandler')
    )
  return false
}

export function cleanVideoFacts(probe: MediaProbe, input: VideoFacts): VideoFacts {
  const facts = videoFacts(probe, 'mov')
  if (
    (probe.chapters?.length ?? 0) !== 0 ||
    probe.streams.length !== (input.audio ? 2 : 1) ||
    facts.video.codec_name !== input.video.codec_name ||
    facts.audio?.codec_name !== input.audio?.codec_name ||
    facts.width !== input.width ||
    facts.height !== input.height ||
    Object.entries(probe.format.tags ?? {}).some(([key, value]) => !cleanFormatTag(key, value)) ||
    probe.streams.some(
      (stream) =>
        (stream.codec_type !== 'video' && stream.codec_type !== 'audio') ||
        (stream.side_data_list?.length ?? 0) !== 0 ||
        Object.entries(stream.tags ?? {}).some(
          ([key, value]) => !cleanStreamTag(stream, key, value),
        ),
    )
  )
    throw new MediaError('processor_failed')
  return facts
}

/** Independent supervisor policy after the contract has parsed an untrusted child result. */
export function validateResult(request: MediaRequest, result: MediaResponse): void {
  if (
    result.v !== request.v ||
    result.jobId !== request.jobId ||
    result.generation !== request.generation ||
    result.nonce !== request.nonce
  )
    throw new MediaError('processor_failed')
  if (result.status === 'failed') return
  const original = result.files.find((file) => file.variant === 'original')
  if (!original) throw new MediaError('processor_failed')
  if (original.bytes > request.maxOutputBytes) throw new MediaError('output_limit')
  if (result.kind === 'file') {
    if (original.bytes !== request.inputBytes || original.sha256 !== request.inputSha256)
      throw new MediaError('processor_failed')
    return
  }
  if ((request.operation === 'video') !== (result.kind === 'video'))
    throw new MediaError('processor_failed')
  if (result.kind === 'image') {
    if (request.operation === 'avatar' && (result.width !== 256 || result.height !== 256))
      throw new MediaError('processor_failed')
    for (const file of result.files) {
      const side =
        file.variant === 'thumb' ? 320 : file.variant === 'preview' ? 1600 : MEDIA_LIMITS.maxSide
      if (file.width === null || file.height === null || file.width > side || file.height > side)
        throw new MediaError('processor_failed')
      if (file.mime !== result.mime) throw new MediaError('processor_failed')
    }
  }
}
