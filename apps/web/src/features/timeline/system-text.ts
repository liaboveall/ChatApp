/**
 * The line a system message shows, worded from what happened and the people's current names (docs/05 section 2: the
 * message stores who and what, never the sentence, so a renamed person is shown under the new name).
 */
import type { Message } from '@chatapp/contracts'
import { m } from '@/paraglide/messages.js'

export function systemText(
  message: Message,
  words: { name: (id: string | null) => string },
): string {
  const event = message.meta.system
  if (event === undefined) return m.system_generic()
  switch (event.type) {
    case 'member_joined':
      return event.addedBy === null
        ? m.system_member_joined({ name: words.name(event.userId) })
        : m.system_member_added({
            name: words.name(event.userId),
            actor: words.name(event.addedBy),
          })
    case 'member_left':
      return m.system_member_left({ name: words.name(event.userId) })
    case 'member_removed':
      return event.banned
        ? m.system_member_banned({
            name: words.name(event.userId),
            actor: words.name(event.actorId),
          })
        : m.system_member_removed({
            name: words.name(event.userId),
            actor: words.name(event.actorId),
          })
    case 'conversation_renamed':
      return m.system_renamed({ actor: words.name(event.actorId), name: event.to })
    case 'owner_transferred':
      return m.system_owner_transferred({
        actor: words.name(event.actorId),
        name: words.name(event.userId),
      })
  }
}
