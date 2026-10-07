import {
  type ExcerptKind,
  LIMITS,
  plainMessageText,
  truncateCodePoints,
  type UserSummary,
} from '@chatapp/contracts'
import { m } from '@/paraglide/messages.js'
export function messageText(
  body: string | null | undefined,
  users: Record<string, UserSummary>,
  kind?: ExcerptKind | null,
): string {
  return truncateCodePoints(
    plainMessageText(body, (id) => users[id]?.displayName, kind, {
      member: m.user_member(),
      image: m.media_excerpt_image(),
      video: m.media_excerpt_video(),
      audio: m.media_excerpt_audio(),
      file: m.media_excerpt_file(),
    }),
    LIMITS.excerptMaxCodePoints,
  )
}
