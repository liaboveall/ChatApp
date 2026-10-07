/** Shared plain-text projection: resolve mentions before shortening, never expose reference ids. */
export type ExcerptKind = 'image' | 'video' | 'audio' | 'file'
export type ExcerptWords = {
  member: string
  image: string
  video: string
  audio: string
  file: string
}
const defaults: ExcerptWords = {
  member: 'member',
  image: '[image]',
  video: '[video]',
  audio: '[audio]',
  file: '[file]',
}
export function plainMessageText(
  body: string | null | undefined,
  name: (id: string) => string | undefined,
  kind?: ExcerptKind | null,
  words: ExcerptWords = defaults,
): string {
  const text = (body ?? '')
    .replace(/<@user:([^>]*)>/gi, (_, id: string) => `@${name(id.toLowerCase()) || words.member}`)
    .replace(/\s+/g, ' ')
    .trim()
  return kind && (!text || text === defaults[kind]) ? words[kind] : text
}
