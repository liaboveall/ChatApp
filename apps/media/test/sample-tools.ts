/** Fixed sample generation and inspection. The runner sends this source to the verified media container, never imports it. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

sharp.concurrency(1)
sharp.cache(false)
const PRIVATE = 'm3-private-metadata-sentinel'
export const SAMPLE_NAMES = [
  'jpeg',
  'png',
  'gif',
  'side-bomb',
  'pixel-bomb',
  'frame-bomb',
  'animated-pixel-bomb',
  'video',
  'ffv1',
  'video-tight',
] as const
export type SampleName = (typeof SAMPLE_NAMES)[number]
type Probe = {
  format: { format_name: string; tags?: Record<string, string> }
  streams: Array<{
    codec_type: string
    codec_name: string
    width?: number
    height?: number
    tags?: Record<string, string>
    side_data_list?: unknown[]
  }>
  chapters?: Array<{ tags?: Record<string, string> }>
}

async function command(args: string[], cwd: string): Promise<Uint8Array> {
  const child = Bun.spawn(args, {
    cwd,
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      TMPDIR: cwd,
      MALLOC_ARENA_MAX: '2',
      UV_THREADPOOL_SIZE: '1',
      VIPS_CONCURRENCY: '1',
      OMP_NUM_THREADS: '1',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  try {
    const bytes = await new Response(child.stdout).bytes()
    if ((await child.exited) !== 0) throw new Error('sample_tool_failed')
    return bytes
  } finally {
    clearTimeout(timer)
  }
}

async function gif(width: number, height: number, frames: number): Promise<Buffer> {
  const single = await sharp({ create: { width, height, channels: 3, background: '#d02030' } })
    .gif()
    .toBuffer()
  const tableSize = (single[10] ?? 0) & 0x80 ? 3 * 2 ** (((single[10] ?? 0) & 7) + 1) : 0
  const headerLength = 13 + tableSize
  // Repeat a complete, valid LZW image block. These are genuine decodable frames, not forged dimension headers.
  const frame = single.subarray(headerLength, single.length - 1)
  return Buffer.concat([
    single.subarray(0, headerLength),
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b]),
  ])
}

async function video(name: SampleName, directory: string): Promise<Uint8Array> {
  await writeFile(
    join(directory, 'request.json'),
    `;FFMETADATA1\ntitle=${PRIVATE}\ncomment=${PRIVATE}\nlocation=+37.3317-122.0307/\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=750\ntitle=${PRIVATE}\n`,
  )
  const pixels = Buffer.alloc(64 * 48 * 3 * 4)
  for (let frame = 0; frame < 4; frame += 1) {
    for (let pixel = 0; pixel < 64 * 48; pixel += 1)
      pixels.set([frame * 60, pixel % 256, 200], (frame * 64 * 48 + pixel) * 3)
  }
  await writeFile(join(directory, 'file-original'), pixels)
  await command(
    [
      '/usr/bin/ffmpeg',
      '-hide_banner',
      '-v',
      'error',
      '-nostdin',
      '-filter_threads',
      '1',
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgb24',
      '-video_size',
      '64x48',
      '-framerate',
      '4',
      '-threads',
      '1',
      '-i',
      join(directory, 'file-original'),
      '-f',
      'ffmetadata',
      '-i',
      join(directory, 'request.json'),
      '-t',
      '1',
      '-map',
      '0:v',
      '-map_metadata',
      name === 'video-tight' ? '-1' : '1',
      '-map_chapters',
      name === 'video-tight' ? '-1' : '1',
      ...(name === 'video-tight'
        ? []
        : [
            '-metadata:s:v:0',
            `title=${PRIVATE}`,
            '-metadata:s:v:0',
            'location=+37.3317-122.0307/',
          ]),
      '-c:v',
      name === 'ffv1' ? 'ffv1' : 'libx264',
      '-threads',
      '1',
      '-f',
      'matroska',
      join(directory, 'file-input'),
    ],
    directory,
  )
  return readFile(join(directory, 'file-input'))
}

async function generate(name: SampleName, directory: string): Promise<Uint8Array> {
  if (name === 'jpeg') {
    const data = Buffer.alloc(64 * 32 * 3)
    const colors = [
      [240, 20, 20],
      [20, 230, 20],
      [20, 20, 240],
      [230, 230, 20],
    ] as const
    for (let y = 0; y < 32; y += 1)
      for (let x = 0; x < 64; x += 1) {
        const color = colors[(x >= 32 ? 1 : 0) + (y >= 16 ? 2 : 0)]
        if (!color) throw new Error('sample_color_missing')
        data.set(color, (y * 64 + x) * 3)
      }
    return sharp(data, { raw: { width: 64, height: 32, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { ImageDescription: PRIVATE, Artist: PRIVATE } })
      .withXmp(
        `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:description="${PRIVATE}"/></rdf:RDF></x:xmpmeta>`,
      )
      .jpeg({ quality: 98, chromaSubsampling: '4:4:4' })
      .toBuffer()
  }
  if (name === 'png') {
    const data = Buffer.alloc(96 * 64 * 4)
    for (let y = 0; y < 64; y += 1)
      for (let x = 0; x < 96; x += 1) data.set([20, 130, 240, x < 48 ? 0 : 128], (y * 96 + x) * 4)
    return sharp(data, { raw: { width: 96, height: 64, channels: 4 } })
      .png()
      .toBuffer()
  }
  if (name === 'gif') {
    const data = Buffer.alloc(24 * 16 * 3 * 3)
    for (let frame = 0; frame < 3; frame += 1)
      for (let pixel = 0; pixel < 24 * 16; pixel += 1) {
        const color = frame === 0 ? [240, 20, 20] : frame === 1 ? [20, 230, 20] : [20, 20, 240]
        data.set(color, (frame * 24 * 16 + pixel) * 3)
      }
    return sharp(data, { raw: { width: 24, height: 48, channels: 3, pageHeight: 16 } })
      .gif({ delay: [120, 180, 240], loop: 0, keepDuplicateFrames: true })
      .toBuffer()
  }
  if (name === 'side-bomb')
    return sharp({ create: { width: 16385, height: 1, channels: 3, background: '#102030' } })
      .png()
      .toBuffer()
  if (name === 'pixel-bomb')
    return sharp({ create: { width: 6500, height: 6200, channels: 3, background: '#102030' } })
      .png()
      .toBuffer()
  if (name === 'frame-bomb') return gif(2, 2, 201)
  if (name === 'animated-pixel-bomb') return gif(1000, 1000, 101)
  return video(name, directory)
}

async function videoFacts(
  bytes: Uint8Array,
  directory: string,
  source: boolean,
): Promise<Record<string, unknown>> {
  await writeFile(join(directory, 'file-input'), bytes)
  const probe = JSON.parse(
    new TextDecoder().decode(
      await command(
        [
          '/usr/bin/ffprobe',
          '-v',
          'error',
          '-threads',
          '1',
          '-show_format',
          '-show_streams',
          '-show_chapters',
          '-of',
          'json',
          join(directory, 'file-input'),
        ],
        directory,
      ),
    ),
  ) as Probe
  const formatTags = probe.format.tags ?? {}
  const streamTags = probe.streams.map((stream) => stream.tags ?? {})
  const text = JSON.stringify(probe)
  // chroma_location is a codec's sampling field, not geographic metadata. Inspect all metadata scopes separately.
  const metadataTags = [
    formatTags,
    ...streamTags,
    ...(probe.chapters ?? []).map((chapter) => chapter.tags ?? {}),
  ]
  const hasLocation = /location|ISO6709|gps/i.test(JSON.stringify(metadataTags))
  const locationFields: string[] = []
  const locate = (value: unknown, path: string) => {
    if (typeof value === 'string' && /location/i.test(value)) locationFields.push(path)
    else if (Array.isArray(value))
      value.forEach((entry, index) => {
        locate(entry, `${path}.${index}`)
      })
    else if (value !== null && typeof value === 'object')
      for (const [key, entry] of Object.entries(value)) {
        const safeKey = /^[a-zA-Z0-9_]{1,50}$/.test(key) ? key : 'unknown'
        if (/location/i.test(key)) locationFields.push(`${path}.${safeKey}`)
        locate(entry, `${path}.${safeKey}`)
      }
  }
  locate(probe, 'probe')
  const hasPrivate = text.includes(PRIVATE)
  const chapters = probe.chapters?.length ?? 0
  const cleanFormat = Object.keys(formatTags).every((key) =>
    ['major_brand', 'minor_version', 'compatible_brands'].includes(key),
  )
  const cleanStreams = streamTags.every((tags) =>
    Object.entries(tags).every(
      ([key, value]) =>
        (key === 'language' && value === 'und') ||
        (key === 'vendor_id' && value === '[0][0][0][0]') ||
        (key === 'handler_name' && ['', 'VideoHandler', 'SoundHandler'].includes(value)),
    ),
  )
  return {
    format: probe.format.format_name,
    codecs: probe.streams.map((stream) => stream.codec_name),
    width: probe.streams.find((stream) => stream.codec_type === 'video')?.width,
    height: probe.streams.find((stream) => stream.codec_type === 'video')?.height,
    sourceHasFormatPrivate: JSON.stringify(formatTags).includes(PRIVATE),
    sourceHasStreamPrivate: JSON.stringify(streamTags).includes(PRIVATE),
    hasLocation,
    locationTokenFields: locationFields,
    hasPrivate,
    chapters,
    cleanFormat,
    cleanStreams,
    formatTagKeys: Object.keys(formatTags),
    streamTagKeys: streamTags.map((tags) => Object.keys(tags)),
    sideDataTypes: probe.streams.flatMap((stream) =>
      (stream.side_data_list ?? []).map((entry) => {
        const value = entry as Record<string, unknown>
        return typeof value.side_data_type === 'string' ? value.side_data_type : 'unknown'
      }),
    ),
    metadataCleared:
      !source &&
      !hasLocation &&
      !hasPrivate &&
      chapters === 0 &&
      cleanFormat &&
      cleanStreams &&
      probe.streams.every((stream) => (stream.side_data_list?.length ?? 0) === 0),
  }
}

async function imageFacts(
  bytes: Uint8Array,
  name: SampleName,
  source: boolean,
  avatar: boolean,
): Promise<Record<string, unknown>> {
  const image = sharp(bytes, { animated: true, limitInputPixels: 200_000_000 })
  const metadata = await image.metadata()
  const frames = metadata.pages ?? 1
  const height = frames > 1 ? metadata.pageHeight : metadata.height
  const cleared =
    !metadata.exif &&
    !metadata.icc &&
    !metadata.xmp &&
    !metadata.iptc &&
    metadata.orientation === undefined &&
    !metadata.hasProfile &&
    !Buffer.from(bytes).includes(Buffer.from(PRIVATE))
  const facts: Record<string, unknown> = {
    format: metadata.format,
    width: metadata.width,
    height,
    frames,
    orientation: metadata.orientation ?? null,
    hasExif: Boolean(metadata.exif),
    hasIcc: Boolean(metadata.icc),
    hasXmp: Boolean(metadata.xmp),
    privateExifPresent: Boolean(metadata.exif?.includes(Buffer.from(PRIVATE))),
    metadataCleared: cleared,
  }
  if (!source && name === 'jpeg' && !avatar) {
    const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const { width, height: pixelHeight, channels } = pixels.info
    const quadrants = [
      [0.25, 0.25],
      [0.75, 0.25],
      [0.25, 0.75],
      [0.75, 0.75],
    ].map(([x = 0, y = 0]) => {
      const offset = (Math.floor(y * pixelHeight) * width + Math.floor(x * width)) * channels
      return [...pixels.data.subarray(offset, offset + 3)]
    })
    const [blue, red, yellow, green] = quadrants
    const near = (color: number[] | undefined, expected: number[]) =>
      color?.every((value, index) => Math.abs(value - (expected[index] ?? -1000)) < 55) ?? false
    facts.orientationPixelsCorrect =
      width === 32 &&
      pixelHeight === 64 &&
      near(blue, [20, 20, 240]) &&
      near(red, [240, 20, 20]) &&
      near(yellow, [230, 230, 20]) &&
      near(green, [20, 230, 20])
  }
  if (!source && name === 'png') {
    const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (x: number) => pixels.data[(32 * pixels.info.width + x) * 4 + 3]
    facts.transparencyPreserved = metadata.hasAlpha && at(24) === 0 && at(72) === 128
  }
  if (!source && name === 'gif') {
    const pixels = await sharp(bytes, { animated: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const colors = Array.from({ length: 3 }, (_, frame) => [
      ...pixels.data.subarray(frame * 24 * 16 * 4, frame * 24 * 16 * 4 + 3),
    ])
    facts.animationPreserved =
      frames === 3 &&
      JSON.stringify(metadata.delay) === '[120,180,240]' &&
      colors.every((color, index) => (color[index] ?? 0) > 180)
  }
  return facts
}

export async function runSampleTool(
  mode: 'generate' | 'source' | 'output' | 'avatar',
  name: SampleName,
): Promise<void> {
  if (!SAMPLE_NAMES.includes(name)) throw new Error('invalid_sample_name')
  const directory = await mkdtemp('/tmp/m3-sample-')
  try {
    if (mode === 'generate') await Bun.write(Bun.stdout, await generate(name, directory))
    else {
      const bytes = await Bun.stdin.bytes()
      const facts =
        name === 'video' || name === 'ffv1'
          ? await videoFacts(bytes, directory, mode === 'source')
          : await imageFacts(bytes, name, mode === 'source', mode === 'avatar')
      console.info(JSON.stringify(facts))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
