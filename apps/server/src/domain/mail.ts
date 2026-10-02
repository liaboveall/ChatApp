/**
 * Delivery of one-time credentials by email (docs/03 section 7). The work item only names the credential; the token is
 * decrypted here, used to build the link, and the encrypted copy is erased once the message has been handed to the
 * mail server. A network failure of unknown outcome retries with the same still-valid credential, so delivery is
 * at-least-once, never promised exactly-once.
 */
import type { ChallengePurpose } from '@chatapp/contracts'
import { authChallenges, users } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { open } from '../lib/crypto.ts'
import type { Deps } from './deps.ts'

export type MailMessage = {
  to: string
  subject: string
  text: string
  /** Stable per work item, so a redelivery after an unknown outcome carries the same Message-ID. */
  messageId: string
}

export interface Mailer {
  send(message: MailMessage): Promise<void>
}

type Template = {
  subject: (product: string) => string
  text: (product: string, link: string) => string
}

const TEMPLATES: Record<ChallengePurpose, Template> = {
  verify_email: {
    subject: (product) => `验证你的 ${product} 邮箱 / Verify your ${product} email`,
    text: (product, link) =>
      `欢迎加入 ${product}。请在 1 小时内打开下面的链接，并在页面上点击“确认”完成邮箱验证：\n\n${link}\n\n` +
      `如果这不是你本人的操作，请忽略这封邮件。\n\n` +
      `Welcome to ${product}. Open the link above within one hour and press "Confirm" to verify your email. ` +
      `If this was not you, ignore this message.\n`,
  },
  reset_password: {
    subject: (product) => `重置你的 ${product} 密码 / Reset your ${product} password`,
    text: (product, link) =>
      `我们收到了重置 ${product} 密码的请求。请在 1 小时内打开下面的链接设置新密码：\n\n${link}\n\n` +
      `如果这不是你本人的操作，请忽略这封邮件，你的密码不会改变。\n\n` +
      `We received a request to reset your ${product} password. Open the link above within one hour. ` +
      `If this was not you, ignore this message; your password stays the same.\n`,
  },
}

/** Credentials travel in the URL fragment, which browsers never send to servers or put in Referer headers. */
const FRAGMENT_PATH: Record<ChallengePurpose, string> = {
  verify_email: '/verify-email',
  reset_password: '/reset-password',
}

export type DeliveryOutcome = 'sent' | 'skipped'

export async function deliverCredentialEmail(
  deps: Deps,
  mailer: Mailer,
  work: { id: string; entityId: string | null },
): Promise<DeliveryOutcome> {
  if (work.entityId === null) return 'skipped'
  const [row] = await deps.db
    .select({ challenge: authChallenges, email: users.email })
    .from(authChallenges)
    .innerJoin(users, eq(users.id, authChallenges.userId))
    .where(eq(authChallenges.id, work.entityId))
    .limit(1)
  const now = deps.clock.now()
  const challenge = row?.challenge
  if (
    !row ||
    !challenge ||
    challenge.consumedAt !== null ||
    challenge.revokedAt !== null ||
    challenge.expiresAt <= now ||
    challenge.deliveryCiphertext === null ||
    challenge.deliveryNonce === null
  ) {
    return 'skipped'
  }
  if (challenge.restoreEpoch !== deps.config.auth.restoreEpoch) return 'skipped'

  const token = open(
    deps.config.auth.tokenEncryptionKey,
    { ciphertext: challenge.deliveryCiphertext, nonce: challenge.deliveryNonce },
    challenge.id,
  )
  const link = `${deps.config.origin}${FRAGMENT_PATH[challenge.purpose]}#token=${token}`
  const template = TEMPLATES[challenge.purpose]
  const product = deps.config.product.name
  await mailer.send({
    to: row.email,
    subject: template.subject(product),
    text: template.text(product, link),
    messageId: `<work-${work.id}@${new URL(deps.config.origin).hostname}>`,
  })

  // Delivered: the encrypted copy is no longer needed (an expired or revoked credential is cleaned the same way).
  await deps.db
    .update(authChallenges)
    .set({ deliveryCiphertext: null, deliveryNonce: null, deliveryKeyVersion: null })
    .where(eq(authChallenges.id, challenge.id))
  return 'sent'
}
