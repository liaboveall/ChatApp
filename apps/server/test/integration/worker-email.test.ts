/**
 * The reliable-work path end to end (D-056, AT-01): committed intent -> dispatcher -> BullMQ -> email consumer -> real
 * SMTP (Mailpit), and the ways it can break: a down mail server, a lost queue job, a redelivered job.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { authChallenges, workItems } from '@chatapp/db'
import { Queue } from 'bullmq'
import { eq } from 'drizzle-orm'
import { createInvite } from '../../src/domain/invites.ts'
import type { Mailer } from '../../src/domain/mail.ts'
import { registerAccount } from '../../src/domain/registration.ts'
import {
  backoffMs,
  claimReadyWork,
  recoverExpiredWork,
  WORK_LIMITS,
} from '../../src/domain/work-queue.ts'
import { createDispatcher } from '../../src/jobs/dispatcher.ts'
import { createEmailWorker, processEmailJob } from '../../src/jobs/email.ts'
import { DEFAULT_JOB_OPTIONS, QUEUE, queuePrefix, type WorkJobData } from '../../src/jobs/queues.ts'
import { createSmtpMailer } from '../../src/jobs/smtp.ts'
import { createBullConnection, createValkey, type Valkey } from '../../src/lib/valkey.ts'
import { createEventBus } from '../../src/realtime/bus.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps, makePrincipal, readLiveToken } from '../support/deps.ts'
import { testConfig } from '../support/env.ts'

const MAILPIT = 'http://localhost:8025'

let dbs: TestDatabases
let valkey: Valkey
let subscriber: Valkey
let closers: Array<() => Promise<unknown> | unknown> = []
const recipients: string[] = []

beforeAll(async () => {
  dbs = openTestDatabases()
  const config = testConfig()
  valkey = await createValkey(config.valkeyUrl, 'test-worker-pub')
  subscriber = await createValkey(config.valkeyUrl, 'test-worker-sub')
})
afterAll(async () => {
  valkey.disconnect()
  subscriber.disconnect()
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
})
afterEach(async () => {
  for (const close of closers.reverse()) await close()
  closers = []
  // Remove only this test's messages from the shared Mailpit (the development mailbox is not ours to empty).
  for (const email of recipients.splice(0)) {
    await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`, {
      method: 'DELETE',
    }).catch(() => undefined)
  }
})

async function mailTo(email: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json()) as {
      messages?: Array<{ ID: string }>
    }
    const id = found.messages?.[0]?.ID
    if (id) {
      const message = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as {
        Text: string
        Subject: string
        MessageID: string
      }
      return message
    }
    await Bun.sleep(150)
  }
  return undefined
}

async function registered(label: string) {
  const deps = makeDeps(dbs.app.db)
  const admin = await createActiveUser(deps, { username: `admin_${label}`, role: 'admin' })
  const principal = await makePrincipal(deps, admin)
  const invite = await createInvite(deps, principal, {})
  const email = `worker-${label}-${Date.now()}@example.test`
  recipients.push(email)
  await registerAccount(deps, {
    email,
    username: `w${label}${Date.now() % 100000}`,
    displayName: 'Worker Test',
    password: 'tomato-umbrella-47-lantern',
    inviteCode: invite.code,
    idempotencyKey: `k-${label}`,
  })
  return { deps, email }
}

function realPipeline(deps: ReturnType<typeof makeDeps>) {
  const config = testConfig()
  const prefix = queuePrefix(`test-${Math.random().toString(36).slice(2)}`)
  const queueConnection = createBullConnection(config.valkeyUrl, 'test-q')
  const consumerConnection = createBullConnection(config.valkeyUrl, 'test-c')
  const queue = new Queue<WorkJobData>(QUEUE.email, {
    connection: queueConnection,
    prefix,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  })
  const worker = createEmailWorker({
    deps,
    mailer: createSmtpMailer(config.smtp),
    log: deps.log,
    connection: consumerConnection,
    environment: prefix.replace('chatapp-', ''),
  })
  // The worker above reads queuePrefix(environment); keep both sides on the same prefix.
  void worker
  const bus = createEventBus({
    publisher: valkey,
    subscriber,
    channel: `events:test:${prefix}`,
    log: deps.log,
  })
  closers.push(async () => {
    await worker.close()
    await queue.obliterate({ force: true }).catch(() => undefined)
    await queue.close()
    queueConnection.disconnect()
    consumerConnection.disconnect()
  })
  return { queue, bus, prefix }
}

describe('verification email through the real pipeline', () => {
  test('a registration commits an intent that ends as a message in Mailpit, with the live credential in its link', async () => {
    const { deps, email } = await registered('a')
    const [row] = await dbs.owner.db.select().from(authChallenges)
    const token = await readLiveToken(deps, row?.userId ?? '', 'verify_email')

    const { queue, bus } = realPipeline(deps)
    const dispatcher = createDispatcher({ deps, bus, emailQueue: queue, log: deps.log })
    expect(await dispatcher.tick()).toBeGreaterThanOrEqual(1)

    const message = await mailTo(email)
    expect(message).toBeDefined()
    expect(message?.Text).toContain(`/verify-email#token=${token}`)
    expect(message?.Text).not.toContain('?token=')
    const [work] = await dbs.owner.db.select().from(workItems).where(eq(workItems.kind, 'email'))
    // Done is recorded after the consumer finished; give it a moment.
    for (
      let i = 0;
      i < 30 &&
      work &&
      (await dbs.owner.db.select().from(workItems).where(eq(workItems.id, work.id)))[0]?.status !==
        'done';
      i += 1
    )
      await Bun.sleep(100)
    const after = (
      await dbs.owner.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, work?.id ?? ''))
    )[0]
    expect(after?.status).toBe('done')
    expect((await dbs.owner.db.select().from(authChallenges))[0]?.deliveryCiphertext).toBeNull()
    // The job id is workId-deliverySeq, without a colon (BullMQ forbids it).
    const jobs = await queue.getJobs(['completed', 'waiting', 'active', 'delayed'])
    expect(jobs.every((job) => !job.id?.includes(':'))).toBe(true)
  })
})

describe('failure modes', () => {
  test('a stale redelivery (same job twice) sends once: the second finds the lease gone', async () => {
    const { deps, email } = await registered('b')
    const sent: string[] = []
    const mailer: Mailer = { send: async (m) => void sent.push(m.messageId) }
    const [claimed] = await claimReadyWork(deps, { limit: 1, kinds: ['email'] })
    const data = { workId: claimed?.id ?? '', leaseEpoch: claimed?.leaseEpoch ?? 0 }
    expect(await processEmailJob({ deps, mailer, log: deps.log }, data)).toBe('sent')
    expect(await processEmailJob({ deps, mailer, log: deps.log }, data)).toBe('stale')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toBe(`<work-${data.workId}@localhost>`)
    void email
  })

  test('a mail server that is down backs off, keeps the credential, and ends in dead after 5 attempts', async () => {
    const { deps } = await registered('c')
    const down: Mailer = createSmtpMailer({
      host: '127.0.0.1',
      port: 1,
      user: undefined,
      pass: undefined,
      from: 'x@example.test',
    })
    const max = WORK_LIMITS.maxAttempts.email
    for (let attempt = 1; attempt <= max; attempt += 1) {
      const [claimed] = await claimReadyWork(deps, { limit: 1, kinds: ['email'] })
      expect(claimed).toBeDefined()
      const result = await processEmailJob(
        { deps, mailer: down, log: deps.log },
        { workId: claimed?.id ?? '', leaseEpoch: claimed?.leaseEpoch ?? 0 },
      )
      expect(result).toBe('failed')
      deps.clock.advance(backoffMs(attempt) + 1_000)
    }
    const [work] = await dbs.owner.db.select().from(workItems).where(eq(workItems.kind, 'email'))
    expect(work).toMatchObject({ status: 'dead', attempts: max })
    // The credential is untouched and still deliverable once someone requeues the item.
    expect((await dbs.owner.db.select().from(authChallenges))[0]?.deliveryCiphertext).toBeTruthy()
  }, 30_000)

  test('a queue job lost after dispatch is recovered from Postgres when the lease expires', async () => {
    const { deps, email } = await registered('d')
    const lostQueue = { add: async () => undefined } as never // the job vanishes, as if Valkey lost it
    const { bus } = realPipeline(deps)
    const dispatcher = createDispatcher({ deps, bus, emailQueue: lostQueue, log: deps.log })
    expect(await dispatcher.tick()).toBeGreaterThanOrEqual(1)
    expect(await mailTo(email, 600)).toBeUndefined()

    deps.clock.advance(WORK_LIMITS.dispatchLeaseMs + 1_000)
    expect(await recoverExpiredWork(deps)).toMatchObject({ requeued: 1 })
    deps.clock.advance(backoffMs(1) + 1_000)
    const sent: string[] = []
    const mailer: Mailer = { send: async (m) => void sent.push(m.to) }
    const [again] = await claimReadyWork(deps, { limit: 1, kinds: ['email'] })
    expect(again?.deliverySeq).toBe(2)
    expect(
      await processEmailJob(
        { deps, mailer, log: deps.log },
        { workId: again?.id ?? '', leaseEpoch: again?.leaseEpoch ?? 0 },
      ),
    ).toBe('sent')
    expect(sent).toEqual([email])
  })
})
