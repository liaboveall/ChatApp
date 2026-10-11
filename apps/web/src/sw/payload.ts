/**
 * The encrypted payload of a push, as the worker reads it (docs/05 `PushPayload`). It is checked by hand: this file ends up
 * in the worker bundle, which should not carry a schema library for one object. The server writes it from the same shape
 * (`packages/contracts/src/notifications.ts`); a payload that does not fit is not shown.
 */
import { SAFE_PATH } from '../lib/pwa/protocol.ts'

export type PushPayload = {
  userId: string
  kind: 'message' | 'mention' | 'reply' | 'approval' | 'reminder' | 'test'
  title: string
  body: string
  url: string
  tag: string
  unread: number
}

const KINDS = ['message', 'mention', 'reply', 'approval', 'reminder', 'test'] as const

export function parsePayload(text: string): PushPayload | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const p = value as Record<string, unknown>
  if (p.v !== 1) return null
  const kind = KINDS.find((candidate) => candidate === p.kind)
  if (
    !kind ||
    typeof p.userId !== 'string' ||
    typeof p.title !== 'string' ||
    p.title.length > 120 ||
    typeof p.body !== 'string' ||
    p.body.length > 240 ||
    typeof p.url !== 'string' ||
    !SAFE_PATH.test(p.url) ||
    typeof p.tag !== 'string' ||
    p.tag.length > 80 ||
    typeof p.unread !== 'number' ||
    !Number.isInteger(p.unread) ||
    p.unread < 0
  ) {
    return null
  }
  return {
    userId: p.userId,
    kind,
    title: p.title,
    body: p.body,
    url: p.url,
    tag: p.tag,
    unread: p.unread,
  }
}

/** Whether a push is for the account this browser is signed in as; anything else is not shown to whoever is here (SEC-34). */
export const isForAccount = (payload: PushPayload, userId: string | undefined): boolean =>
  userId !== undefined && payload.userId === userId

/**
 * Whether a sign-out message applies to the account the worker knows. The message names the account that signed out (when the
 * sender knew it); one that names somebody else was sent by a tab of the previous person and arrived after the next one signed
 * in, so it is not about them. A message that names nobody applies to whoever is known.
 */
export const forgetApplies = (known: string | undefined, about: string | undefined): boolean =>
  about === undefined || known === undefined || known === about
