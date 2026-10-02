/** Mail the app sent during a test, read from Mailpit's HTTP API (docs/09 section 4). Local development only. */
const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025'

type Summary = { ID: string; Created: string }

async function search(recipient: string): Promise<Summary[]> {
  const response = await fetch(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`,
  )
  if (!response.ok) throw new Error(`Mailpit answered ${response.status}`)
  return ((await response.json()) as { messages?: Summary[] }).messages ?? []
}

export type Mail = { id: string; text: string }

/**
 * Waits for the newest message to `recipient` that arrived after `since` (ms). The worker delivers within a second or
 * two. `exclude` lists mails the test already has: Mailpit stamps a mail with its own clock, and a time window alone
 * cannot tell a second mail from the first one when they arrive close together.
 */
export async function waitForMail(
  recipient: string,
  since = 0,
  timeoutMs = 20_000,
  exclude: readonly string[] = [],
): Promise<Mail> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = (await search(recipient)).filter(
      (message) => Date.parse(message.Created) >= since && !exclude.includes(message.ID),
    )
    const newest = found.sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0]
    if (newest) {
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${newest.ID}`)).json()) as {
        Text: string
      }
      return { id: newest.ID, text: detail.Text }
    }
    if (Date.now() > deadline) throw new Error(`no mail for ${recipient} within ${timeoutMs} ms`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

/** The one-time link from a mail body: path and token, without the origin. */
export function linkIn(
  mail: Mail,
  path: '/verify-email' | '/reset-password',
): { path: string; token: string } {
  const match = new RegExp(`${path}#token=([A-Za-z0-9_-]{43})`).exec(mail.text)
  if (!match?.[1]) throw new Error(`no ${path} link in the mail`)
  return { path, token: match[1] }
}

export async function deleteMail(id: string): Promise<void> {
  await fetch(`${MAILPIT}/api/v1/messages`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: [id] }),
  })
}
