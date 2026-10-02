import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { authChallenges, users } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { issueChallenge } from '../../src/domain/challenges.ts'
import { deliverCredentialEmail, type Mailer, type MailMessage } from '../../src/domain/mail.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps } from '../support/deps.ts'

let dbs: TestDatabases
beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
})

function recorder(options: { failWith?: Error } = {}) {
  const sent: MailMessage[] = []
  const mailer: Mailer = {
    send: async (message) => {
      if (options.failWith) throw options.failWith
      sent.push(message)
    },
  }
  return { sent, mailer }
}

async function issued(purpose: 'verify_email' | 'reset_password') {
  const deps = makeDeps(dbs.app.db)
  const user = await createActiveUser(deps, { username: 'mailed' })
  const [row] = await dbs.owner.db.select().from(users).where(eq(users.id, user.id))
  if (!row) throw new Error('no user')
  const challenge = await deps.db.transaction((tx) =>
    issueChallenge(tx, deps, { user: row, registrationId: null, purpose }),
  )
  return { deps, user, challenge }
}

describe('credential email delivery', () => {
  test('sends the link with the token in the fragment, a stable Message-ID, then erases the encrypted copy', async () => {
    const { deps, user, challenge } = await issued('verify_email')
    const { sent, mailer } = recorder()
    const outcome = await deliverCredentialEmail(deps, mailer, {
      id: 'work-1',
      entityId: challenge.id,
    })
    expect(outcome).toBe('sent')
    expect(sent).toHaveLength(1)
    const [message] = sent
    expect(message?.to).toBe(user.email)
    expect(message?.messageId).toBe('<work-work-1@localhost>')
    expect(message?.text).toContain(`http://localhost:5173/verify-email#token=${challenge.token}`)
    // Never in the query string, which would reach logs and Referer headers.
    expect(message?.text).not.toContain('?token=')
    const [row] = await dbs.owner.db
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.id, challenge.id))
    expect(row).toMatchObject({
      deliveryCiphertext: null,
      deliveryNonce: null,
      deliveryKeyVersion: null,
    })
    // The credential itself stays valid for use (it is only the delivery copy that goes away).
    expect(row?.consumedAt).toBeNull()
    expect(row?.revokedAt).toBeNull()
  })

  test('reset emails use the reset path', async () => {
    const { deps, challenge } = await issued('reset_password')
    const { sent, mailer } = recorder()
    await deliverCredentialEmail(deps, mailer, { id: 'w', entityId: challenge.id })
    expect(sent[0]?.text).toContain('/reset-password#token=')
  })

  test('a failed send keeps the encrypted copy so the retry can send the same credential', async () => {
    const { deps, challenge } = await issued('verify_email')
    const { mailer } = recorder({ failWith: new Error('connection reset') })
    await expect(
      deliverCredentialEmail(deps, mailer, { id: 'w', entityId: challenge.id }),
    ).rejects.toThrow('connection reset')
    const [row] = await dbs.owner.db
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.id, challenge.id))
    expect(row?.deliveryCiphertext).toBeTruthy()
    const retry = recorder()
    expect(
      await deliverCredentialEmail(deps, retry.mailer, { id: 'w', entityId: challenge.id }),
    ).toBe('sent')
    expect(retry.sent[0]?.text).toContain(challenge.token)
  })

  test('nothing is sent for a consumed, revoked, expired or foreign-generation credential', async () => {
    for (const mutate of ['consumed', 'revoked', 'expired', 'restore'] as const) {
      await truncateAll(dbs.owner)
      const { deps, challenge } = await issued('verify_email')
      let target = deps
      if (mutate === 'consumed')
        await dbs.owner.db
          .update(authChallenges)
          .set({ consumedAt: new Date() })
          .where(eq(authChallenges.id, challenge.id))
      if (mutate === 'revoked')
        await dbs.owner.db
          .update(authChallenges)
          .set({ revokedAt: new Date() })
          .where(eq(authChallenges.id, challenge.id))
      if (mutate === 'expired') deps.clock.advance(61 * 60_000)
      if (mutate === 'restore')
        target = {
          ...deps,
          config: { ...deps.config, auth: { ...deps.config.auth, restoreEpoch: 'other' } },
        }
      const { sent, mailer } = recorder()
      expect(
        await deliverCredentialEmail(target, mailer, { id: 'w', entityId: challenge.id }),
      ).toBe('skipped')
      expect(sent).toHaveLength(0)
    }
  })

  test('unknown or missing entity ids are skipped, not errors', async () => {
    const deps = makeDeps(dbs.app.db)
    const { sent, mailer } = recorder()
    expect(await deliverCredentialEmail(deps, mailer, { id: 'w', entityId: null })).toBe('skipped')
    expect(await deliverCredentialEmail(deps, mailer, { id: 'w', entityId: deps.newId() })).toBe(
      'skipped',
    )
    expect(sent).toHaveLength(0)
  })

  test('the delivery copy is bound to its row: a ciphertext moved to another credential does not decrypt', async () => {
    const { deps, challenge } = await issued('verify_email')
    const other = await issued('reset_password').catch(() => undefined)
    void other
    const [source] = await dbs.owner.db
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.id, challenge.id))
    const [target] = (await dbs.owner.db.select().from(authChallenges)).filter(
      (c) => c.id !== challenge.id,
    )
    if (!source || !target) return
    await dbs.owner.db
      .update(authChallenges)
      .set({ deliveryCiphertext: source.deliveryCiphertext, deliveryNonce: source.deliveryNonce })
      .where(eq(authChallenges.id, target.id))
    const { mailer } = recorder()
    await expect(
      deliverCredentialEmail(deps, mailer, { id: 'w', entityId: target.id }),
    ).rejects.toThrow()
  })
})
