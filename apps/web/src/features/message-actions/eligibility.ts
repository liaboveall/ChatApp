/**
 * Which actions the interface offers on a message (docs/01 sections 4.5 and 5, D-154). The server decides what is allowed
 * (`decide()` in `domain/authorize.ts` and the time windows in `domain/messages.ts`); this only mirrors those rules so the
 * menu does not show what would be refused. A refusal that still happens (the window ran out while the menu was open) is
 * handled where the action is called. Pure: the clock is an argument.
 */
import { type Conversation, LIMITS, type Message } from '@chatapp/contracts'

export type ActionInput = {
  message: Message
  meId: string
  conversation: Pick<Conversation, 'kind' | 'archivedAt'> & {
    me: { role: 'owner' | 'admin' | 'member'; silencedUntil: string | null } | null
  }
  siteRole: 'user' | 'admin'
  /** Milliseconds, as the server's clock reads (the client corrects its own with the server's time). */
  now: number
}

export type MessageActions = {
  reply: boolean
  copy: boolean
  edit: boolean
  recall: boolean
  hideForMe: boolean
  adminDelete: boolean
}

export const noActions: MessageActions = {
  reply: false,
  copy: false,
  edit: false,
  recall: false,
  hideForMe: false,
  adminDelete: false,
}

export function actionsFor(input: ActionInput): MessageActions {
  const { message, meId, conversation, siteRole, now } = input
  const me = conversation.me
  const live = conversation.archivedAt === null
  const silenced = me?.silencedUntil != null && Date.parse(me.silencedUntil) > now
  const gone = message.recalledAt !== null || message.deletedAt !== null
  const isSystem = message.kind === 'system'
  const mine = message.senderId === meId && message.kind === 'user'
  const age = now - Date.parse(message.createdAt)
  const canSpeak = me !== null && live && !silenced

  return {
    reply: canSpeak && !gone && !isSystem,
    copy: message.body !== null && message.body !== '',
    edit:
      canSpeak && mine && !gone && message.status === 'sent' && age < LIMITS.messageEditWindowMs,
    // The server adds five seconds of grace for the network; the client shows the plain two minutes (L-07).
    recall: me !== null && live && mine && !gone && age < LIMITS.messageRecallWindowMs,
    hideForMe: me !== null,
    adminDelete:
      live &&
      !isSystem &&
      message.deletedAt === null &&
      conversation.kind !== 'dm' &&
      ((me !== null && (me.role === 'owner' || me.role === 'admin')) ||
        (siteRole === 'admin' && me !== null)),
  }
}

/** Whether any action at all is offered (an empty menu is not opened). */
export const hasAny = (actions: MessageActions): boolean => Object.values(actions).some(Boolean)

/** The newest message of mine that "up arrow in an empty field" would edit, if any. */
export function lastEditable(
  messages: readonly Message[],
  input: Omit<ActionInput, 'message'>,
): Message | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && actionsFor({ ...input, message }).edit) return message
  }
  return undefined
}
