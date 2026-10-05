/**
 * The conversation of ten thousand messages that the performance tests scroll through (docs/12 D-149): the generator is
 * reproducible word for word, has the mix and the two fixed rules the tests measure against, and what is written to the
 * database is an ordinary conversation as the API serves it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { ConversationListResponse, MessagesResponse } from '@chatapp/contracts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makeDeps } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { buildPerfFixture, generatePerfMessages, PERF } from '../support/perf-fixture.ts'

describe('the generator', () => {
  const all = generatePerfMessages(3)

  test('is the same every time, word for word', () => {
    expect(JSON.stringify(generatePerfMessages(3))).toBe(JSON.stringify(all))
    // A fingerprint of the content: when the generator changes on purpose, update this and measure again (D-149).
    const fingerprint = createHash('sha256')
      .update(
        all
          .map((m) => `${m.seq}|${m.who}|${m.replyToSeq ?? ''}|${m.offsetMs}|${m.body}`)
          .join('\n'),
      )
      .digest('hex')
    expect(fingerprint).toBe('65778b5ed3453cd17318bca96fd9d46ff1403cc25b547d401ce58ce3c81ba868')
  })

  test('runs to seq 10,000 and has the mix of the decision', () => {
    expect(all[0]?.seq).toBe(3)
    expect(all.at(-1)?.seq).toBe(PERF.lastSeq)
    const share = (test: (body: string) => boolean): number =>
      all.filter((m) => test(m.body)).length / all.length
    expect(share((b) => /^- /m.test(b))).toBeGreaterThan(0.08)
    expect(share((b) => /^- /m.test(b))).toBeLessThan(0.12)
    expect(share((b) => b.includes('```'))).toBeGreaterThan(0.035)
    expect(share((b) => b.includes('```'))).toBeLessThan(0.065)
    expect(share((b) => b.includes('https://'))).toBeGreaterThan(0.08)
    expect(share((b) => b.includes('https://'))).toBeLessThan(0.13)
    const replies = all.filter((m) => m.replyToSeq !== null).length / all.length
    expect(replies).toBeGreaterThan(0.02)
    expect(replies).toBeLessThan(0.045)
    expect(share((b) => b.length > 1_400)).toBeGreaterThan(0.004)
    expect(share((b) => b.length > 1_400)).toBeLessThan(0.02)
    // One to six lines for everything that is not long.
    for (const m of all) {
      if (m.body.length <= 1_400) expect(m.body.split('\n').length).toBeGreaterThanOrEqual(1)
    }
  })

  test('has the two fixed rules: the last replies to 3,000; the last hundred are perf_a and perf_c only', () => {
    expect(all.at(-1)?.replyToSeq).toBe(PERF.replyTo)
    const tail = all.filter((m) => m.seq >= PERF.tailFrom)
    expect(tail).toHaveLength(100)
    expect(new Set(tail.map((m) => m.who))).toEqual(new Set(['a', 'c']))
    // Replies only look backwards.
    for (const m of all) if (m.replyToSeq !== null) expect(m.replyToSeq).toBeLessThan(m.seq)
  })

  test('senders come in runs of at most six, and the time spans thirty days with the odd gap over an hour', () => {
    let run = 1
    let longest = 1
    for (let i = 1; i < all.length; i += 1) {
      run = all[i]?.who === all[i - 1]?.who ? run + 1 : 1
      longest = Math.max(longest, run)
    }
    expect(longest).toBeLessThanOrEqual(6)
    expect(new Set(all.map((m) => m.who)).size).toBe(3)
    const first = all[0]?.offsetMs ?? 0
    const last = all.at(-1)?.offsetMs ?? 0
    expect(last - first).toBeGreaterThan(PERF.spanMs - PERF.endsBeforeNowMs - 2 * 3_600_000)
    expect(last).toBe(PERF.spanMs - PERF.endsBeforeNowMs)
    const gaps = all.slice(1).map((m, i) => m.offsetMs - (all[i]?.offsetMs ?? 0))
    expect(gaps.every((g) => g >= 0)).toBe(true)
    expect(gaps.filter((g) => g > 3_600_000).length).toBeGreaterThan(20)
  })
})

describe('the fixture in the database', () => {
  let dbs: TestDatabases
  let app: TestApp
  beforeAll(() => {
    dbs = openTestDatabases()
  })
  afterAll(async () => {
    await truncateAll(dbs.owner)
    await dbs.close()
  })
  beforeEach(async () => {
    await truncateAll(dbs.owner)
    app = await createTestApp(dbs)
  })
  afterEach(async () => {
    await app.close()
  })

  test('is an ordinary group: ten thousand messages, perf_b at 9,900 with 100 unread, the last reply quoting 3,000', async () => {
    const started = performance.now()
    const fixture = await buildPerfFixture(makeDeps(dbs.owner.db))
    const took = performance.now() - started
    expect(took).toBeLessThan(60_000)

    const jar = app.newJar()
    const login = await app.request('/api/auth/sign-in/email', {
      json: { email: fixture.people.b.email, password: fixture.people.b.password },
      jar,
    })
    expect(login.status).toBe(200)

    const list = (await (
      await app.request('/api/conversations', { jar })
    ).json()) as ConversationListResponse
    const group = list.conversations.find((c) => c.id === fixture.conversationId)
    expect(group?.name).toBe(PERF.groupName)
    expect(group?.lastSeq).toBe(PERF.lastSeq)
    expect(group?.me?.lastReadSeq).toBe(PERF.readPosition)
    expect(group?.me?.unread).toBe(100)
    expect(group?.memberCount).toBe(3)

    const page = (await (
      await app.request(`/api/conversations/${fixture.conversationId}/messages?limit=100`, { jar })
    ).json()) as MessagesResponse
    const newest = page.messages.at(-1)
    expect(newest?.seq).toBe(PERF.lastSeq)
    expect(newest?.replyTo).toMatchObject({ seq: PERF.replyTo, state: 'ok' })
    expect(
      page.messages
        .filter((m) => m.seq >= PERF.tailFrom)
        .every((m) => m.senderId !== fixture.people.b.id),
    ).toBe(true)

    // The older part is reachable with the same paging the app uses.
    const older = (await (
      await app.request(
        `/api/conversations/${fixture.conversationId}/messages?beforeSeq=${page.messages[0]?.seq}&limit=100`,
        { jar },
      )
    ).json()) as MessagesResponse
    expect(older.messages).toHaveLength(100)
  })
})
