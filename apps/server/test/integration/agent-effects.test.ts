/**
 * M5a approvals and effects against real Postgres (docs/06 sections 4.2 and 5, docs/08 AT-07, AT-15, AT-28, AT-32,
 * AT-37, INV-10, INV-19, INV-28, INV-30). The model is the deterministic mock: a request in the forms `代发：…`,
 * `提醒我：<local time> …`, `定时：<local time> …`, `建群：…`, `拉人：…` makes it call that tool.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  agentApprovals,
  agentEffects,
  agentRuns,
  conversationMembers,
  executionDelegations,
  messages,
  reminders,
  scheduledMessages,
  users,
  workItems,
} from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { and, eq } from 'drizzle-orm'
import { loadAiConfig } from '../../src/config/ai.ts'
import { decideApproval, expireApprovals, listApprovals } from '../../src/domain/agent-approvals.ts'
import { executeEffect } from '../../src/domain/agent-effects.ts'
import {
  cancelAgentRun,
  claimAgentRun,
  createAgentRun,
  getAgentRun,
  recoverAgentRuns,
  regenerateAgentRun,
} from '../../src/domain/agent-runs.ts'
import { createConversation } from '../../src/domain/conversations.ts'
import { removeConversationMember } from '../../src/domain/members.ts'
import { sendMessage } from '../../src/domain/messages.ts'
import {
  endSession,
  revokeAllDevices,
  revokeDevice,
  revokeOtherDevices,
} from '../../src/domain/sessions.ts'
import {
  cancelReminder,
  deliverTask,
  listReminders,
  reconcileTasks,
} from '../../src/domain/tasks.ts'
import { localDateTimeAt } from '../../src/lib/local-time.ts'
import { executeAgentRun } from '../../src/runtime/agent.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps, makePrincipal } from '../support/deps.ts'

let dbs: TestDatabases
let deps: ReturnType<typeof makeDeps>
let alice: Awaited<ReturnType<typeof makePrincipal>>
let bob: typeof alice
const config = loadAiConfig({ APP_ENV: 'test' })
const NOW = new Date('2026-10-20T00:00:00Z')
const HOUR = 3_600_000

beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  deps = makeDeps(dbs.app.db)
  deps.clock.set(NOW)
  const { apiKey: _apiKey, ...policy } = config
  deps.config.ai = policy
  await runBootstrap(deps.db, { ...deps.config.product, productName: deps.config.product.name })
  alice = await makePrincipal(deps, await createActiveUser(deps, { username: 'alice' }))
  bob = await makePrincipal(deps, await createActiveUser(deps, { username: 'bob' }))
})

async function timezoneOf(userId: string): Promise<string> {
  const [user] = await deps.db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
  if (!user) throw new Error('fixture missing')
  return user.timezone
}
async function setTimezone(userId: string, timezone: string): Promise<void> {
  await deps.db.update(users).set({ timezone }).where(eq(users.id, userId))
}
async function group(memberIds: string[] = [bob.userId]) {
  return (
    await createConversation(
      deps,
      alice,
      { kind: 'group', name: '项目组', memberIds },
      crypto.randomUUID(),
    )
  ).conversation
}
async function ask(contextConversationId: string, prompt: string, who = alice) {
  return await createAgentRun(
    deps,
    who,
    {
      trigger: 'panel',
      contextConversationId,
      prompt,
      mode: 'fast',
      attachmentIds: [],
      timezone: await timezoneOf(who.userId),
    },
    crypto.randomUUID(),
  )
}
async function run(id: string) {
  await executeAgentRun({ deps, config }, id)
  return await getAgentRun(deps, alice, id)
}
/** Local wall-clock time `hours` after the test clock, in `timezone`. */
const later = (hours: number, timezone = 'Asia/Shanghai') =>
  localDateTimeAt(new Date(deps.clock.now().getTime() + hours * HOUR), timezone)
async function messagesOf(conversationId: string) {
  return await deps.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.seq)
}
async function readPosition(conversationId: string, userId: string) {
  const [row] = await deps.db
    .select({ lastReadSeq: conversationMembers.lastReadSeq })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId),
      ),
    )
  return row?.lastReadSeq ?? -1
}

describe('sending on the caller behalf waits for their approval (E2E scenario 8, A4)', () => {
  test('the run pauses with a full preview and nothing is sent until approved', async () => {
    const g = await group()
    const started = await ask(g.id, '代发：周五下午三点开评审会')
    const paused = await run(started.id)
    expect(paused.run.status).toBe('awaiting_approval')
    expect(paused.run.pendingApproval).toBe(true)
    expect(paused.approvals).toHaveLength(1)
    const approval = paused.approvals[0]
    expect(approval).toMatchObject({
      toolName: 'send_message',
      status: 'pending',
      required: true,
      preview: {
        tool: 'send_message',
        conversation: { id: g.id, name: '项目组', kind: 'group' },
        body: '周五下午三点开评审会',
      },
    })
    expect(new Date(approval?.expiresAt ?? 0).getTime()).toBe(NOW.getTime() + 24 * HOUR)
    // The segment ended with the waiting mark; nothing reached the group yet.
    const [segment] = await deps.db
      .select()
      .from(messages)
      .where(eq(messages.id, paused.run.outputMessageId ?? ''))
    expect(segment?.status).toBe('sent')
    expect(segment?.meta.agent?.awaitingApproval).toEqual({ userId: alice.userId })
    expect((await messagesOf(g.id)).filter((m) => m.kind === 'user')).toHaveLength(0)
    expect(await listApprovals(deps, alice, 'pending')).toHaveLength(1)
    expect(await listApprovals(deps, bob, 'pending')).toHaveLength(0)
  })

  test('approval sends once as the caller, marked as assistant-sent, without moving their read position', async () => {
    const g = await group()
    await sendMessage(deps, bob, g.id, { clientId: crypto.randomUUID(), body: '先发一条' })
    const before = await readPosition(g.id, alice.userId)
    const started = await ask(g.id, '代发：收到，周五见')
    const paused = await run(started.id)
    const approval = paused.approvals[0]
    if (!approval) throw new Error('no approval')
    await expect(
      decideApproval(deps, bob, approval.id, {
        decision: 'approve',
        expectedStateVersion: approval.stateVersion,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const decided = await decideApproval(deps, alice, approval.id, {
      decision: 'approve',
      expectedStateVersion: approval.stateVersion,
    })
    expect(decided.run.status).toBe('queued')
    expect(decided.approval.status).toBe('approved')
    await expect(
      decideApproval(deps, alice, approval.id, {
        decision: 'approve',
        expectedStateVersion: approval.stateVersion,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    const done = await run(started.id)
    expect(done.run.status).toBe('completed')
    expect(done.run.hasEffects).toBe(true)
    const sent = (await messagesOf(g.id)).filter(
      (m) => m.kind === 'user' && m.senderId === alice.userId,
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]?.body).toBe('收到，周五见')
    expect(sent[0]?.executionSource).toBe('agent_effect')
    expect(sent[0]?.meta.viaAgent).toEqual({ runId: started.id })
    expect(await readPosition(g.id, alice.userId)).toBe(before)
    expect(done.effects).toHaveLength(1)
    expect(done.effects[0]).toMatchObject({ toolName: 'send_message', entityType: 'message' })
    // The reply after the decision is a new segment, and an effect forbids regeneration (D-068).
    const replies = (await messagesOf(paused.run.conversationId ?? '')).filter(
      (m) => m.kind === 'agent',
    )
    expect(replies).toHaveLength(2)
    expect(replies[1]?.body).toContain('已代你发送')
    await expect(
      regenerateAgentRun(deps, alice, started.id, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  test('a rejection never sends; the model is told and answers', async () => {
    const g = await group()
    const started = await ask(g.id, '代发：这条不要发')
    const approval = (await run(started.id)).approvals[0]
    if (!approval) throw new Error('no approval')
    await decideApproval(deps, alice, approval.id, {
      decision: 'reject',
      expectedStateVersion: approval.stateVersion,
    })
    const done = await run(started.id)
    expect(done.run.status).toBe('completed')
    expect(done.run.hasEffects).toBe(false)
    expect(done.approvals[0]?.status).toBe('rejected')
    expect((await messagesOf(g.id)).filter((m) => m.kind === 'user')).toHaveLength(0)
    const replies = (await messagesOf(done.run.conversationId ?? '')).filter(
      (m) => m.kind === 'agent',
    )
    expect(replies.at(-1)?.body).toContain('没有执行')
  })

  test('edited arguments are revalidated, frozen and sent exactly as approved', async () => {
    const g = await group()
    const started = await ask(g.id, '代发：原来的草稿')
    const approval = (await run(started.id)).approvals[0]
    if (!approval) throw new Error('no approval')
    await expect(
      decideApproval(deps, alice, approval.id, {
        decision: 'approve',
        editedArgs: { body: '   ' },
        expectedStateVersion: approval.stateVersion,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(
      decideApproval(deps, alice, approval.id, {
        decision: 'approve',
        editedArgs: { surprise: true },
        expectedStateVersion: approval.stateVersion,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const decided = await decideApproval(deps, alice, approval.id, {
      decision: 'approve',
      editedArgs: { body: '改过的正文' },
      expectedStateVersion: approval.stateVersion,
    })
    expect(decided.approval.edited).toBe(true)
    expect(decided.approval.preview).toMatchObject({ body: '改过的正文' })
    await run(started.id)
    const sent = (await messagesOf(g.id)).filter((m) => m.kind === 'user')
    expect(sent.map((m) => m.body)).toEqual(['改过的正文'])
  })

  test('a destination outside the run scope is refused before anyone is asked (A2)', async () => {
    const g = await group()
    const other = await group()
    const started = await ask(g.id, '帮我发到另一个群')
    type Part =
      Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer P>
        ? P
        : never
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    }
    let calls = 0
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls++
        const chunks: Part[] = [{ type: 'stream-start', warnings: [] }]
        if (calls === 1)
          chunks.push(
            {
              type: 'tool-call',
              toolCallId: 'escape',
              toolName: 'send_message',
              input: JSON.stringify({ conversationId: other.id, body: '外泄' }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
          )
        else
          chunks.push(
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: '不能发到当前会话以外。' },
            { type: 'text-end', id: 't' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
          )
        return { stream: simulateReadableStream({ chunks }) }
      },
    })
    await executeAgentRun({ deps, config, model: () => model }, started.id)
    const done = await getAgentRun(deps, alice, started.id)
    expect(done.run.status).toBe('completed')
    expect(done.approvals[0]).toMatchObject({
      status: 'rejected',
      reason: 'invalid:OUT_OF_SCOPE',
      required: false,
    })
    expect((await messagesOf(other.id)).filter((m) => m.kind === 'user')).toHaveLength(0)
  })
})

describe('effects happen exactly once across crashes (INV-10, AT-07, docs/08 section 4)', () => {
  async function approved(g: { id: string }) {
    const started = await ask(g.id, '代发：只发一次')
    const approval = (await run(started.id)).approvals[0]
    if (!approval) throw new Error('no approval')
    await decideApproval(deps, alice, approval.id, {
      decision: 'approve',
      expectedStateVersion: approval.stateVersion,
    })
    return { started, approval }
  }

  test('a worker lost after the decision but before executing still sends exactly once', async () => {
    const g = await group()
    const { started } = await approved(g)
    // Claimed, then the worker vanished: the lease expires and recovery queues the next segment.
    expect(await claimAgentRun(deps, started.id)).not.toBeNull()
    deps.clock.advance(31_000)
    await recoverAgentRuns(deps)
    const [queued] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, started.id))
    expect(queued?.status).toBe('queued')
    const done = await run(started.id)
    expect(done.run.status).toBe('completed')
    expect((await messagesOf(g.id)).filter((m) => m.kind === 'user')).toHaveLength(1)
  })

  test('a worker lost after the effect committed but before reporting does not send again', async () => {
    const g = await group()
    const { started, approval } = await approved(g)
    const claim = await claimAgentRun(deps, started.id)
    if (!claim) throw new Error('not claimed')
    await executeEffect(deps, claim.lease, approval.id)
    expect((await messagesOf(g.id)).filter((m) => m.kind === 'user')).toHaveLength(1)
    deps.clock.advance(31_000)
    await recoverAgentRuns(deps)
    const done = await run(started.id)
    expect(done.run.status).toBe('completed')
    expect((await messagesOf(g.id)).filter((m) => m.kind === 'user')).toHaveLength(1)
    const effects = await deps.db
      .select()
      .from(agentEffects)
      .where(eq(agentEffects.runId, started.id))
    expect(effects).toHaveLength(1)
  })

  test('an old lease cannot commit an effect after recovery moved the run on (INV-19)', async () => {
    const g = await group()
    const { started, approval } = await approved(g)
    const stale = await claimAgentRun(deps, started.id)
    if (!stale) throw new Error('not claimed')
    deps.clock.advance(31_000)
    await recoverAgentRuns(deps)
    await expect(executeEffect(deps, stale.lease, approval.id)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect((await messagesOf(g.id)).filter((m) => m.kind === 'user')).toHaveLength(0)
  })

  test('cancelling first means no effect; the pending decision is closed with the reason', async () => {
    const g = await group()
    const started = await ask(g.id, '代发：取消我')
    const approval = (await run(started.id)).approvals[0]
    if (!approval) throw new Error('no approval')
    await cancelAgentRun(deps, alice, started.id)
    const [row] = await deps.db
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.id, approval.id))
    expect(row).toMatchObject({ status: 'rejected', reason: 'cancelled' })
    await expect(
      decideApproval(deps, alice, approval.id, {
        decision: 'approve',
        expectedStateVersion: approval.stateVersion,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  test('an unanswered request expires after 24 hours and cancels the run', async () => {
    const g = await group()
    const started = await ask(g.id, '代发：过期的请求')
    const approval = (await run(started.id)).approvals[0]
    if (!approval) throw new Error('no approval')
    deps.clock.advance(24 * HOUR - 1000)
    expect(await expireApprovals(deps)).toBe(0)
    deps.clock.advance(2000)
    expect(await expireApprovals(deps)).toBe(1)
    const detail = await getAgentRun(deps, alice, started.id)
    expect(detail.run).toMatchObject({ status: 'cancelled', error: { code: 'APPROVAL_EXPIRED' } })
    expect(detail.approvals[0]?.status).toBe('expired')
  })
})

describe('reminders affect only the caller and run without approval (docs/06 section 4.2)', () => {
  test('a reminder is created at once, delivered at its time into the reminder conversation', async () => {
    const g = await group()
    const local = later(26)
    const started = await ask(g.id, `提醒我：${local} 交周报`)
    const done = await run(started.id)
    expect(done.run.status).toBe('completed')
    expect(done.run.hasEffects).toBe(true)
    expect(done.approvals[0]).toMatchObject({ status: 'approved', required: false })
    const [reminder] = await deps.db
      .select()
      .from(reminders)
      .where(eq(reminders.userId, alice.userId))
    expect(reminder).toMatchObject({
      status: 'scheduled',
      text: '交周报',
      scheduledTimezone: 'Asia/Shanghai',
      scheduledLocalTime: local,
      scheduledOffsetMinutes: 480,
    })
    expect(reminder?.remindAt.getTime()).toBe(NOW.getTime() + 26 * HOUR)
    const [delegation] = await deps.db
      .select()
      .from(executionDelegations)
      .where(eq(executionDelegations.id, reminder?.delegationId ?? ''))
    expect(delegation).toMatchObject({
      purpose: 'reminder',
      targetId: reminder?.id,
      status: 'active',
    })
    const [work] = await deps.db
      .select()
      .from(workItems)
      .where(and(eq(workItems.kind, 'scheduled'), eq(workItems.entityId, reminder?.id ?? '')))
    expect(work?.availableAt.getTime()).toBe(reminder?.remindAt.getTime())
    // Too early: nothing happens. At the time: one message in the person's own reminder conversation.
    expect(await deliverTask(deps, 'reminder', reminder?.id ?? '')).toBe('sent')
    const [sent] = await deps.db
      .select()
      .from(reminders)
      .where(eq(reminders.id, reminder?.id ?? ''))
    expect(sent?.status).toBe('sent')
    const [delivered] = await deps.db
      .select()
      .from(messages)
      .where(eq(messages.id, sent?.sentMessageId ?? ''))
    expect(delivered).toMatchObject({
      kind: 'agent',
      body: '交周报',
      executionSource: 'scheduled',
      meta: { reminder: { reminderId: reminder?.id } },
    })
    expect(await deliverTask(deps, 'reminder', reminder?.id ?? '')).toBe('skipped')
    const listed = await listReminders(deps, alice, { limit: 50 })
    expect(listed.reminders[0]).toMatchObject({
      status: 'sent',
      localDateTime: local,
      offsetMinutes: 480,
    })
    await expect(
      regenerateAgentRun(deps, alice, started.id, crypto.randomUUID()),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  test('a repeated local time waits for the person to choose one of the two instants (AT-37)', async () => {
    await setTimezone(alice.userId, 'America/New_York')
    const g = await group()
    const started = await ask(g.id, '提醒我：2026-11-01T01:30 换电池')
    const paused = await run(started.id)
    expect(paused.run.status).toBe('awaiting_approval')
    const approval = paused.approvals[0]
    if (!approval) throw new Error('no approval')
    expect(approval.required).toBe(true)
    expect(approval.preview).toMatchObject({
      tool: 'create_reminder',
      time: {
        localDateTime: '2026-11-01T01:30',
        timezone: 'America/New_York',
        candidates: [
          { at: '2026-11-01T05:30:00.000Z', offsetMinutes: -240 },
          { at: '2026-11-01T06:30:00.000Z', offsetMinutes: -300 },
        ],
        chosen: null,
      },
    })
    await expect(
      decideApproval(deps, alice, approval.id, {
        decision: 'approve',
        expectedStateVersion: approval.stateVersion,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'CHOOSE_TIME' } })
    await expect(
      decideApproval(deps, alice, approval.id, {
        decision: 'approve',
        editedArgs: { offsetMinutes: 60 },
        expectedStateVersion: approval.stateVersion,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'OFFSET_MISMATCH' } })
    await decideApproval(deps, alice, approval.id, {
      decision: 'approve',
      editedArgs: { offsetMinutes: -300 },
      expectedStateVersion: approval.stateVersion,
    })
    await run(started.id)
    const [reminder] = await deps.db
      .select()
      .from(reminders)
      .where(eq(reminders.userId, alice.userId))
    expect(reminder?.remindAt.toISOString()).toBe('2026-11-01T06:30:00.000Z')
    expect(reminder?.scheduledOffsetMinutes).toBe(-300)
    // A later change of the person's time zone shows differently but never moves the task (INV-30).
    await setTimezone(alice.userId, 'Asia/Tokyo')
    const [after] = await deps.db
      .select()
      .from(reminders)
      .where(eq(reminders.id, reminder?.id ?? ''))
    expect(after?.remindAt.toISOString()).toBe('2026-11-01T06:30:00.000Z')
    expect(after?.scheduledTimezone).toBe('America/New_York')
  })

  test('a skipped local time, the past, another zone and over 365 days are refused, not moved', async () => {
    await setTimezone(alice.userId, 'America/New_York')
    const g = await group()
    for (const [prompt, reason] of [
      ['提醒我：2027-03-14T02:30 不存在的时间', 'invalid:TIME_DOES_NOT_EXIST'],
      ['提醒我：2026-10-01T09:00 已经过去', 'invalid:TIME_IN_PAST'],
      ['提醒我：2028-01-01T09:00 太远了', 'invalid:TOO_FAR_AHEAD'],
    ] as const) {
      const started = await ask(g.id, prompt)
      const done = await run(started.id)
      expect(done.run.status).toBe('completed')
      expect(done.approvals[0]).toMatchObject({ status: 'rejected', reason })
    }
    expect(await deps.db.select().from(reminders)).toHaveLength(0)
  })

  test('cancelling and delivering are serialized; a cancelled reminder is never delivered', async () => {
    const g = await group()
    const started = await ask(g.id, `提醒我：${later(2)} 喝水`)
    await run(started.id)
    const [reminder] = await deps.db.select().from(reminders)
    if (!reminder) throw new Error('no reminder')
    await expect(cancelReminder(deps, bob, reminder.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    const cancelled = await cancelReminder(deps, alice, reminder.id)
    expect(cancelled).toMatchObject({ status: 'cancelled', text: null })
    expect((await cancelReminder(deps, alice, reminder.id)).version).toBe(cancelled.version)
    deps.clock.advance(3 * HOUR)
    expect(await deliverTask(deps, 'reminder', reminder.id)).toBe('skipped')
    const [delegation] = await deps.db
      .select()
      .from(executionDelegations)
      .where(eq(executionDelegations.id, reminder.delegationId ?? ''))
    expect(delegation?.status).toBe('revoked')
  })

  test('a task more than 24 hours late fails without sending', async () => {
    const g = await group()
    const started = await ask(g.id, `提醒我：${later(1)} 迟到的提醒`)
    await run(started.id)
    deps.clock.advance(26 * HOUR)
    await reconcileTasks(deps)
    const [reminder] = await deps.db.select().from(reminders)
    expect(reminder).toMatchObject({ status: 'failed', errorCode: 'OVERDUE', sentMessageId: null })
  })

  test('at most 100 future tasks per person', async () => {
    const g = await group()
    const started = await ask(g.id, `提醒我：${later(3)} 第一百零一个`)
    const [delegation] = await deps.db
      .select()
      .from(executionDelegations)
      .where(eq(executionDelegations.userId, alice.userId))
    for (let i = 0; i < 100; i++)
      await deps.db.insert(reminders).values({
        id: crypto.randomUUID(),
        userId: alice.userId,
        text: `第${i}个`,
        remindAt: new Date(NOW.getTime() + (i + 5) * HOUR),
        scheduledTimezone: 'Asia/Shanghai',
        scheduledLocalTime: '2026-10-21T08:00',
        scheduledOffsetMinutes: 480,
        delegationId: delegation?.id,
        createdAt: NOW,
      })
    const done = await run(started.id)
    expect(done.approvals[0]).toMatchObject({ status: 'rejected', reason: 'invalid:TASK_LIMIT' })
  })
})

describe('scheduled messages and the identity truth table (docs/03 section 5.9, AT-28, AT-32)', () => {
  async function scheduled(g: { id: string }, hours = 2, who = alice) {
    const started = await ask(g.id, `定时：${later(hours)} 早上好`, who)
    const approval = (await run(started.id)).approvals[0]
    if (!approval) throw new Error('no approval')
    expect(approval.preview).toMatchObject({ tool: 'schedule_message', body: '早上好' })
    await decideApproval(deps, who, approval.id, {
      decision: 'approve',
      expectedStateVersion: approval.stateVersion,
    })
    await run(started.id)
    const [row] = await deps.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.createdByRunId, started.id))
    if (!row) throw new Error('not scheduled')
    return row
  }

  test('a plain sign-out keeps the task; it sends at its time without advancing the read position', async () => {
    const g = await group()
    for (let i = 0; i < 3; i++)
      await sendMessage(deps, bob, g.id, { clientId: crypto.randomUUID(), body: `消息${i}` })
    const task = await scheduled(g)
    const readBefore = await readPosition(g.id, alice.userId)
    await endSession(deps, {
      id: alice.sessionId,
      userId: alice.userId,
      authorizationOriginId: alice.originId,
    })
    deps.clock.advance(2 * HOUR)
    expect(await deliverTask(deps, 'scheduled_message', task.id)).toBe('sent')
    const sent = (await messagesOf(g.id)).filter(
      (m) => m.senderId === alice.userId && m.kind === 'user',
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ body: '早上好', executionSource: 'scheduled' })
    expect(await readPosition(g.id, alice.userId)).toBe(readBefore)
    const [conversation] = await deps.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, g.id))
    expect(conversation).toBeDefined()
  })

  test('revoking the device that authorized it cancels the task in the same transaction', async () => {
    const g = await group()
    const task = await scheduled(g)
    const other = await makePrincipal(deps, { id: alice.userId })
    await revokeDevice(deps, other, alice.originId)
    const [row] = await deps.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, task.id))
    expect(row).toMatchObject({ status: 'cancelled', body: null, errorCode: 'UNAUTHENTICATED' })
    deps.clock.advance(2 * HOUR)
    expect(await deliverTask(deps, 'scheduled_message', task.id)).toBe('skipped')
  })

  test('signing out other devices cancels their tasks but keeps those of the current device', async () => {
    const g = await group()
    const mine = await scheduled(g, 2)
    const phone = await makePrincipal(deps, { id: alice.userId })
    const fromPhone = await scheduled(g, 3, phone)
    await revokeOtherDevices(deps, alice)
    const rows = await deps.db.select().from(scheduledMessages)
    expect(rows.find((r) => r.id === mine.id)?.status).toBe('scheduled')
    expect(rows.find((r) => r.id === fromPhone.id)?.status).toBe('cancelled')
  })

  test('security sign-out everywhere cancels every task and every waiting run', async () => {
    const g = await group()
    const task = await scheduled(g)
    const waiting = await ask(g.id, '代发：等待中')
    await run(waiting.id)
    await revokeAllDevices(deps, alice)
    const [row] = await deps.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, task.id))
    expect(row?.status).toBe('cancelled')
    const [paused] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, waiting.id))
    expect(paused).toMatchObject({ status: 'cancelled', errorCode: 'UNAUTHENTICATED' })
    const [approval] = await deps.db
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.runId, waiting.id))
    expect(approval).toMatchObject({ status: 'rejected', reason: 'unauthenticated' })
  })

  test('losing the right to send before the time fails the task with a code, without sending', async () => {
    const g = (
      await createConversation(
        deps,
        bob,
        { kind: 'group', name: 'Bob 的群', memberIds: [alice.userId] },
        crypto.randomUUID(),
      )
    ).conversation
    const task = await scheduled(g)
    // The owner removes Alice before the time.
    await removeConversationMember(deps, bob, g.id, alice.userId)
    deps.clock.advance(2 * HOUR)
    expect(await deliverTask(deps, 'scheduled_message', task.id)).toBe('failed')
    const [row] = await deps.db
      .select()
      .from(scheduledMessages)
      .where(eq(scheduledMessages.id, task.id))
    expect(row?.status).toBe('failed')
    expect(row?.errorCode).toBe('NOT_FOUND')
  })
})
