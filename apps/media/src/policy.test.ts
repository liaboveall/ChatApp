import { describe, expect, test } from 'bun:test'
import {
  MEDIA_LIMITS,
  type MediaRequest,
  type MediaSuccess,
  mediaResponseSchema,
} from '@chatapp/contracts/media'
import { type MediaProbe, mediaProbeSchema } from '@chatapp/contracts/media-probe'
import {
  cleanVideoFacts,
  failureCode,
  imageBounds,
  imageDecodeFailure,
  imageFormat,
  MediaError,
  outputName,
  probeArgs,
  remuxArgs,
  TASK_FILES,
  validateResult,
  videoDemuxer,
  videoFacts,
} from './policy.ts'
import { mediaEnvironment } from './runtime/environment.ts'
import { taskDirectoryName, temporaryRootPath } from './runtime/files.ts'

const identity = {
  v: 1 as const,
  jobId: '019fbfff-3c4f-7c15-a2e3-f80fa8b19fba',
  generation: 4,
  nonce: 'a'.repeat(64),
}
const request: MediaRequest = {
  ...identity,
  operation: 'image',
  inputBytes: 32,
  inputSha256: 'b'.repeat(64),
  maxOutputBytes: MEDIA_LIMITS.imageBytes,
}
const result: MediaSuccess = {
  ...identity,
  status: 'ok',
  kind: 'image',
  mime: 'image/webp',
  width: 600,
  height: 400,
  durationMs: null,
  metadataCleared: true,
  thumbhash: 'AQ==',
  files: [
    {
      variant: 'original',
      mime: 'image/webp',
      bytes: 100,
      sha256: 'c'.repeat(64),
      width: 600,
      height: 400,
    },
    {
      variant: 'thumb',
      mime: 'image/webp',
      bytes: 30,
      sha256: 'd'.repeat(64),
      width: 300,
      height: 200,
    },
    {
      variant: 'preview',
      mime: 'image/webp',
      bytes: 50,
      sha256: 'e'.repeat(64),
      width: 600,
      height: 400,
    },
  ],
}
const probe: MediaProbe = {
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.000000' },
  streams: [
    {
      index: 0,
      codec_type: 'video',
      codec_name: 'h264',
      width: 1280,
      height: 720,
      duration: '10.000000',
    },
  ],
  chapters: [],
}

function bytes(text: string): Uint8Array {
  return Uint8Array.from([...text], (character) => character.charCodeAt(0))
}

function iso(brand: string, compatible = ''): Uint8Array {
  const data = new Uint8Array(16 + compatible.length)
  new DataView(data.buffer).setUint32(0, data.byteLength)
  data.set(bytes('ftyp'), 4)
  data.set(bytes(brand), 8)
  data.set(bytes(compatible), 16)
  return data
}

describe('raster admission without loading native decoders', () => {
  test('the five raster signatures are whitelisted', () => {
    expect(imageFormat(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('jpeg')
    expect(imageFormat(new Uint8Array([0x89, ...bytes('PNG\r\n\u001a\n')]))).toBe('png')
    expect(imageFormat(bytes('GIF87a'))).toBe('gif')
    expect(imageFormat(bytes('GIF89a'))).toBe('gif')
    expect(imageFormat(bytes('RIFF0000WEBP'))).toBe('webp')
    expect(imageFormat(iso('avif'))).toBe('avif')
    expect(imageFormat(iso('mif1', 'avif'))).toBe('avif')
  })
  for (const source of [
    '<svg/>',
    '<?xml version="1.0"?><svg/>',
    '<!DOCTYPE html><html/>',
    '\ufeff <svg/>',
    'GIF8',
    'RIFF0000WAVE',
    'II*\u0000',
    '%PDF',
  ]) {
    test(`never selects a decoder for ${JSON.stringify(source)}`, () =>
      expect(imageFormat(bytes(source))).toBeNull())
  }
  test('HEIC and video containers are not AVIF', () => {
    expect(imageFormat(iso('heic'))).toBeNull()
    expect(imageFormat(iso('isom'))).toBeNull()
  })
  test('static pixels and rotated dimensions are checked separately', () => {
    expect(
      imageBounds({ format: 'jpeg', width: 8000, height: 5000, orientation: 6 }, 'jpeg'),
    ).toEqual({ width: 5000, height: 8000, frames: 1, animated: false })
    expect(() => imageBounds({ format: 'jpeg', width: 8000, height: 5001 }, 'jpeg')).toThrow(
      'input_limit',
    )
    expect(() => imageBounds({ format: 'png', width: 16385, height: 1 }, 'png')).toThrow(
      'input_limit',
    )
  })
  test('animation admits exactly 200 frames and exactly 100 MP total', () => {
    expect(
      imageBounds(
        { format: 'gif', width: 1000, height: 100000, pageHeight: 500, pages: 200 },
        'gif',
      ),
    ).toEqual({ width: 1000, height: 500, frames: 200, animated: true })
    expect(() =>
      imageBounds(
        { format: 'gif', width: 1000, height: 100200, pageHeight: 501, pages: 200 },
        'gif',
      ),
    ).toThrow('input_limit')
    expect(() =>
      imageBounds({ format: 'gif', width: 1, height: 201, pageHeight: 1, pages: 201 }, 'gif'),
    ).toThrow('input_limit')
  })
  test('per-frame side limit is not confused with stacked animation height', () => {
    expect(
      imageBounds({ format: 'webp', width: 10, height: 32768, pageHeight: 16384, pages: 2 }, 'webp')
        .height,
    ).toBe(16384)
    expect(() =>
      imageBounds({ format: 'gif', width: 1, height: 32770, pageHeight: 16385, pages: 2 }, 'gif'),
    ).toThrow('input_limit')
  })
  for (const change of [
    { width: 0 },
    { height: -1 },
    { width: 1.5 },
    { pages: 0 },
    { pages: 2 },
    { orientation: 9 },
    { pages: 2, pageHeight: 20 },
  ]) {
    test(`malformed dimensions/frames are rejected: ${JSON.stringify(change)}`, () => {
      expect(() => imageBounds({ format: 'png', width: 10, height: 10, ...change }, 'png')).toThrow(
        'invalid_input',
      )
    })
  }
  test('decoder format must match magic, including AV1 rather than HEVC', () => {
    expect(() => imageBounds({ format: 'svg', width: 10, height: 10 }, 'png')).toThrow(
      'unsupported',
    )
    expect(() =>
      imageBounds({ format: 'heif', compression: 'hevc', width: 10, height: 10 }, 'avif'),
    ).toThrow('unsupported')
    expect(
      imageBounds({ format: 'heif', compression: 'av1', width: 10, height: 10 }, 'avif').frames,
    ).toBe(1)
  })
})

describe('bounded video policy without executing ffmpeg', () => {
  test('only fixed container demuxers, never a playlist or URL', () => {
    expect(videoDemuxer(iso('isom'))).toBe('mov')
    expect(videoDemuxer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe('matroska')
    expect(videoDemuxer(bytes('RIFF0000AVI '))).toBe('avi')
    for (const data of [
      bytes('#EXTM3U\nhttps://example.test'),
      bytes('<MPD/>'),
      bytes('https://example.test'),
      iso('avif'),
      new Uint8Array(),
    ])
      expect(videoDemuxer(data)).toBeNull()
  })
  test('probe arguments restrict protocols, demuxers and external MOV references', () => {
    const args = probeArgs('/tmp/chatapp-media/task-abcdef/file-input', 'mov')
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,pipe')
    expect(args[args.indexOf('-format_whitelist') + 1]).toBe('mov,matroska,webm,avi')
    expect(args[args.indexOf('-enable_drefs') + 1]).toBe('0')
    expect(args[args.indexOf('-use_absolute_path') + 1]).toBe('0')
    expect(args[args.indexOf('-f') + 1]).toBe('mov')
    expect(args).not.toContain('concat')
    expect(args).not.toContain('hls')
  })
  test('remux copies only audio/video, clears all metadata scopes, and streams rather than truncates', () => {
    const args = remuxArgs('/tmp/chatapp-media/task-abcdef/file-input', 'avi')
    expect(args[args.indexOf('-c') + 1]).toBe('copy')
    for (const option of ['-map_metadata', '-map_metadata:s', '-map_chapters'])
      expect(args[args.indexOf(option) + 1]).toBe('-1')
    expect(args).toContain('0:V:0')
    expect(args).toContain('0:a:0?')
    expect(args.at(-1)).toBe('pipe:1')
    expect(args).not.toContain('-fs')
  })
  test('ffprobe schema rejects extra paths and unbounded data', () => {
    expect(mediaProbeSchema.safeParse(probe).success).toBe(true)
    expect(mediaProbeSchema.safeParse({ ...probe, filename: '/private/path' }).success).toBe(false)
    expect(
      mediaProbeSchema.safeParse({
        ...probe,
        format: { ...probe.format, filename: '/private/path' },
      }).success,
    ).toBe(false)
    expect(
      mediaProbeSchema.safeParse({
        ...probe,
        streams: Array.from({ length: 17 }, () => probe.streams[0]),
      }).success,
    ).toBe(false)
    expect(
      mediaProbeSchema.safeParse({
        ...probe,
        format: { ...probe.format, tags: { comment: 'x'.repeat(4097) } },
      }).success,
    ).toBe(false)
    expect(
      mediaProbeSchema.safeParse({
        ...probe,
        format: {
          ...probe.format,
          tags: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`key${i}`, 'x'])),
        },
      }).success,
    ).toBe(false)
  })
  test('duration cap includes every track; unknown duration is not admitted', () => {
    expect(
      videoFacts({ ...probe, format: { ...probe.format, duration: '1800' } }, 'mov').durationMs,
    ).toBe(1800000)
    expect(() =>
      videoFacts({ ...probe, format: { ...probe.format, duration: '1800.001' } }, 'mov'),
    ).toThrow('input_limit')
    expect(() =>
      videoFacts(
        {
          ...probe,
          streams: [...probe.streams, { index: 1, codec_type: 'audio', duration: '1801' }],
        },
        'mov',
      ),
    ).toThrow('input_limit')
    expect(() =>
      videoFacts(
        {
          ...probe,
          format: { format_name: probe.format.format_name },
          streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1, height: 1 }],
        },
        'mov',
      ),
    ).toThrow('unsupported')
  })
  test('audio-only, cover-art-only, excessive dimensions and mismatched demuxers fail admission', () => {
    expect(() =>
      videoFacts({ ...probe, streams: [{ index: 0, codec_type: 'audio' }] }, 'mov'),
    ).toThrow('unsupported')
    expect(() =>
      videoFacts(
        {
          ...probe,
          streams: [
            {
              ...probe.streams[0],
              index: 0,
              codec_type: 'video',
              disposition: { attached_pic: 1 },
            },
          ],
        },
        'mov',
      ),
    ).toThrow('unsupported')
    expect(() =>
      videoFacts(
        {
          ...probe,
          streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 16385, height: 1 }],
        },
        'mov',
      ),
    ).toThrow('input_limit')
    expect(() => videoFacts(probe, 'avi')).toThrow('unsupported')
  })
  test('only generated MP4 structural tags survive the metadata check', () => {
    const cleaned = {
      ...probe,
      format: {
        ...probe.format,
        tags: { major_brand: 'mp42', minor_version: '512', compatible_brands: 'mp42iso5avc1mp41' },
      },
      streams: [
        {
          index: 0,
          codec_type: 'video' as const,
          codec_name: 'h264',
          width: 1280,
          height: 720,
          tags: { language: 'und', handler_name: 'VideoHandler', vendor_id: '[0][0][0][0]' },
        },
      ],
    }
    expect(cleanVideoFacts(mediaProbeSchema.parse(cleaned), videoFacts(probe, 'mov')).width).toBe(
      1280,
    )
    for (const key of [
      'location',
      'creation_time',
      'encoder',
      'comment',
      'com.apple.quicktime.location.ISO6709',
    ]) {
      expect(() =>
        cleanVideoFacts(
          { ...probe, format: { ...probe.format, tags: { [key]: 'private' } } },
          videoFacts(probe, 'mov'),
        ),
      ).toThrow('processor_failed')
      expect(() =>
        cleanVideoFacts(
          {
            ...probe,
            streams: [
              {
                index: 0,
                codec_type: 'video',
                codec_name: 'h264',
                width: 1280,
                height: 720,
                tags: { [key]: 'private' },
              },
            ],
          },
          videoFacts(probe, 'mov'),
        ),
      ).toThrow('processor_failed')
    }
  })
  test('chapters, arbitrary handler names, side-data and lost tracks cannot be claimed clean', () => {
    const input = videoFacts(probe, 'mov')
    expect(() => cleanVideoFacts({ ...probe, chapters: [{ id: 1 }] }, input)).toThrow(
      'processor_failed',
    )
    expect(() =>
      cleanVideoFacts(
        {
          ...probe,
          streams: [
            {
              index: 0,
              codec_type: 'video',
              codec_name: 'h264',
              width: 1280,
              height: 720,
              tags: { handler_name: 'private' },
            },
          ],
        },
        input,
      ),
    ).toThrow('processor_failed')
    expect(() =>
      cleanVideoFacts(
        {
          ...probe,
          streams: [
            {
              index: 0,
              codec_type: 'video',
              codec_name: 'h264',
              width: 1280,
              height: 720,
              side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }],
            },
          ],
        },
        input,
      ),
    ).toThrow('processor_failed')
    expect(() =>
      cleanVideoFacts(probe, {
        ...input,
        audio: { index: 1, codec_type: 'audio', codec_name: 'aac' },
      }),
    ).toThrow('processor_failed')
  })
})

describe('independent child-result admission', () => {
  test('valid image response and fixed failure pass', () => {
    expect(() => validateResult(request, mediaResponseSchema.parse(result))).not.toThrow()
    expect(() =>
      validateResult(request, { ...identity, status: 'failed', code: 'invalid_input' }),
    ).not.toThrow()
  })
  for (const change of [
    { nonce: 'f'.repeat(64) },
    { generation: 5 },
    { jobId: '019fbfff-3c4f-7c15-a2e3-f80fa8b19fbb' },
  ]) {
    test(`identity cannot change: ${JSON.stringify(change)}`, () =>
      expect(() => validateResult(request, { ...result, ...change })).toThrow('processor_failed'))
  }
  test('request output cap is stricter than the global cap', () => {
    expect(() => validateResult({ ...request, maxOutputBytes: 99 }, result)).toThrow('output_limit')
  })
  test('thumb/preview dimensions and avatar square are independently checked', () => {
    for (const [variant, width] of [
      ['thumb', 321],
      ['preview', 1601],
    ] as const) {
      const changed = {
        ...result,
        files: result.files.map((file) => (file.variant === variant ? { ...file, width } : file)),
      }
      expect(() => validateResult(request, mediaResponseSchema.parse(changed))).toThrow(
        'processor_failed',
      )
    }
    expect(() => validateResult({ ...request, operation: 'avatar' }, result)).toThrow(
      'processor_failed',
    )
    const avatar = {
      ...result,
      width: 256,
      height: 256,
      files: result.files.map((file) => ({ ...file, width: 256, height: 256 })),
    }
    expect(() =>
      validateResult({ ...request, operation: 'avatar' }, mediaResponseSchema.parse(avatar)),
    ).not.toThrow()
  })
  test('download-only fallback must be the exact original input, not arbitrary child bytes', () => {
    const fallback: MediaSuccess = {
      ...identity,
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
          bytes: request.inputBytes,
          sha256: request.inputSha256,
          width: null,
          height: null,
        },
      ],
    }
    expect(() => validateResult(request, mediaResponseSchema.parse(fallback))).not.toThrow()
    expect(() =>
      validateResult(request, {
        ...fallback,
        files: fallback.files.map((file) => ({ ...file, sha256: 'f'.repeat(64) })),
      }),
    ).toThrow('processor_failed')
    expect(() =>
      validateResult(request, {
        ...fallback,
        files: fallback.files.map((file) => ({ ...file, bytes: file.bytes + 1 })),
      }),
    ).toThrow('processor_failed')
  })
  test('operation does not permit an inline image response to a video job', () => {
    expect(() => validateResult({ ...request, operation: 'video' }, result)).toThrow(
      'processor_failed',
    )
  })
})

describe('fixed environment, paths and failure vocabulary', () => {
  test('environment has an explicit technical allowlist and no ambient inheritance', () => {
    const env = mediaEnvironment('/tmp/chatapp-media/task-abcdef')
    expect(Object.keys(env).sort()).toEqual(
      [
        'BUN_JSC_numberOfGCMarkers',
        'BUN_JSC_numberOfDFGCompilerThreads',
        'BUN_JSC_numberOfFTLCompilerThreads',
        'BUN_JSC_maxNumberOfWorklistThreads',
        'LANG',
        'MALLOC_ARENA_MAX',
        'OMP_NUM_THREADS',
        'PATH',
        'TMPDIR',
        'UV_THREADPOOL_SIZE',
        'VIPS_CONCURRENCY',
      ].sort(),
    )
    expect(env.TMPDIR).toBe('/tmp/chatapp-media/task-abcdef')
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(env).not.toHaveProperty('APP_ENV') // The test runner's preload sets APP_ENV; it must not leak.
    expect(env).not.toHaveProperty('HOME')
  })
  test('cleanup roots cannot be /, /tmp, arbitrary host paths or normalized traversal aliases', () => {
    expect(temporaryRootPath('/tmp/chatapp-media')).toBe(true)
    expect(temporaryRootPath('/tmp/media-fault')).toBe(true)
    for (const path of [
      '/',
      '/tmp',
      '/home/mars',
      '/app',
      '/tmp/..',
      '/tmp/a/../b',
      '/tmp/a/b',
      'tmp/media',
    ])
      expect(temporaryRootPath(path)).toBe(false)
    expect(taskDirectoryName('task-aBc012')).toBe(true)
    for (const name of ['task-', 'task-abcdefg', '../task-abcdef', 'other-abcdef', 'task-../..'])
      expect(taskDirectoryName(name)).toBe(false)
  })
  test('only fixed output filenames, never result-supplied paths', () => {
    expect(
      ['original', 'thumb', 'preview'].map((variant) =>
        outputName(variant as 'original' | 'thumb' | 'preview'),
      ),
    ).toEqual(['file-original', 'file-thumb', 'file-preview'])
    expect(TASK_FILES.input).toBe('file-input')
    expect(TASK_FILES.request).toBe('request.json')
    expect(TASK_FILES.result).toBe('result.json')
  })
  test('native pixel-limit failures keep a fixed limit code without returning native details', () => {
    expect(imageDecodeFailure(new Error('Input image exceeds pixel limit')).code).toBe(
      'input_limit',
    )
    expect(imageDecodeFailure(new Error('invalid native input and private path')).code).toBe(
      'invalid_input',
    )
    expect(imageDecodeFailure(new MediaError('output_limit')).code).toBe('output_limit')
  })
  test('raw native/library exceptions are converted to a fixed code', () => {
    expect(failureCode(new Error('untrusted input or decoder path'))).toBe('processor_failed')
    expect(failureCode(new MediaError('input_limit'))).toBe('input_limit')
    expect(failureCode('untrusted')).toBe('processor_failed')
  })
})
