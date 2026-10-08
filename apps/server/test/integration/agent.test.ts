import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import {
  agentRunOutputs,
  agentRunStates,
  agentRuns,
  agentSteps,
  aiCallAttempts,
  appSettings,
  attachments,
  budgetAccounts,
  conversationMembers,
  messages,
  users,
} from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { generateText, isStepCount, simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { and, eq } from 'drizzle-orm'
import { answerReminder } from '../../src/agent/prompts/system.ts'
import { agentTools } from '../../src/agent/tools/index.ts'
import { AI_LIMITS, loadAiConfig } from '../../src/config/ai.ts'
import { authorizeAgentDelta, withAgentLease } from '../../src/domain/agent-access.ts'
import {
  closeAgentCalls,
  createAgentLedger,
  getAgentUsage,
  recordAgentEvidence,
  resolveAttempt,
} from '../../src/domain/agent-budget.ts'
import {
  cancelAgentRun,
  claimAgentRun,
  completeAgentRun,
  createAgentRun,
  deleteAgentConversation,
  ensureAgentOutput,
  getAgentRun,
  persistAgentText,
  purgeAgentContent,
  recoverAgentRuns,
  regenerateAgentRun,
} from '../../src/domain/agent-runs.ts'
import {
  buildAgentContext,
  executeAgentTool,
  saveAgentModelStep,
} from '../../src/domain/agent-tools.ts'
import { createConversation } from '../../src/domain/conversations.ts'
import { addConversationMembers, removeConversationMember } from '../../src/domain/members.ts'
import { editMessage, sendMessage } from '../../src/domain/messages.ts'
import { searchMessages } from '../../src/domain/search.ts'
import { endSession, revokeAllDevices } from '../../src/domain/sessions.ts'
import { executeAgentRun } from '../../src/runtime/agent.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps, makePrincipal } from '../support/deps.ts'

let dbs: TestDatabases
let deps: ReturnType<typeof makeDeps>
let alice: Awaited<ReturnType<typeof makePrincipal>>
let bob: typeof alice
const config = loadAiConfig({ APP_ENV: 'test' })
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
  const { apiKey: _apiKey, ...policy } = config
  deps.config.ai = policy
  await runBootstrap(deps.db, { ...deps.config.product, productName: deps.config.product.name })
  alice = await makePrincipal(deps, await createActiveUser(deps, { username: 'alice' }))
  bob = await makePrincipal(deps, await createActiveUser(deps, { username: 'bob' }))
})
async function start(extra: Partial<Parameters<typeof createAgentRun>[2]> = {}, who = alice) {
  const [user] = await deps.db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, who.userId))
  if (!user) throw new Error('fixture missing')
  return createAgentRun(
    deps,
    who,
    {
      trigger: 'agent_chat',
      prompt: '请总结可见消息',
      mode: 'fast',
      attachmentIds: [],
      timezone: user.timezone,
      ...extra,
    },
    crypto.randomUUID(),
  )
}
const group = async (memberIds: string[] = [bob.userId]) =>
  (
    await createConversation(
      deps,
      alice,
      { kind: 'group', name: '工程讨论', memberIds },
      crypto.randomUUID(),
    )
  ).conversation
const say = async (conversationId: string, body: string, who = alice) =>
  (await sendMessage(deps, who, conversationId, { clientId: crypto.randomUUID(), body })).envelope
    .message
async function claimed(id: string) {
  const c = await claimAgentRun(deps, id)
  if (!c) throw new Error('run not claimed')
  return c
}

test('a real tool loop persists output, steps, usage and one durable output; unrelated users get 404', async () => {
  const run = await start()
  await executeAgentRun({ deps, config }, run.id)
  const detail = await getAgentRun(deps, alice, run.id)
  expect(detail.run.status).toBe('completed')
  expect(
    detail.steps.some((s) => s.type === 'tool_call' && s.toolName === 'read_conversation'),
  ).toBe(true)
  expect(detail.run.usage.inputTokens).toBeGreaterThan(0)
  const [output] = await deps.db
    .select()
    .from(messages)
    .where(eq(messages.id, detail.run.outputMessageId ?? '00000000-0000-0000-0000-000000000000'))
  expect(output?.status).toBe('sent')
  expect(output?.senderId).not.toBe(alice.userId)
  await expect(getAgentRun(deps, bob, run.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  await executeAgentRun({ deps, config }, run.id)
  expect((await getAgentRun(deps, alice, run.id)).run.usage).toEqual(detail.run.usage)
  expect((await getAgentUsage(deps, alice)).daily.reserved).toBe(0)
})

test('new panel sessions preserve separate histories; selecting or deleting one leaves the others private and intact', async () => {
  const g = await group()
  const first = await start({
    trigger: 'panel',
    contextConversationId: g.id,
    prompt: '第一段私有请求',
    newConversation: true,
  })
  await executeAgentRun({ deps, config }, first.id)
  const second = await start({
    trigger: 'panel',
    contextConversationId: g.id,
    prompt: '第二段私有请求',
    newConversation: true,
  })
  expect(second.conversationId).not.toBe(first.conversationId)
  const c = await claimed(second.id)
  expect(JSON.stringify((await buildAgentContext(deps, c.lease)).history)).not.toContain(
    '第一段私有请求',
  )
  await cancelAgentRun(deps, alice, second.id)
  const again = await start({
    trigger: 'panel',
    contextConversationId: g.id,
    conversationId: first.conversationId ?? undefined,
  })
  expect(again.conversationId).toBe(first.conversationId)
  await cancelAgentRun(deps, alice, again.id)
  const latest = await start({ trigger: 'panel', contextConversationId: g.id })
  expect(latest.conversationId).toBe(second.conversationId)
  await cancelAgentRun(deps, alice, latest.id)
  if (!second.conversationId) throw new Error('panel missing')
  await expect(deleteAgentConversation(deps, bob, second.conversationId)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
  await deleteAgentConversation(deps, alice, second.conversationId)
  expect((await getAgentRun(deps, alice, first.id)).run.status).toBe('completed')
  await expect(getAgentRun(deps, alice, second.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

test('a new session cannot also target a saved conversation', async () => {
  const first = await start()
  await expect(
    start({ conversationId: first.conversationId ?? undefined, newConversation: true }),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  await cancelAgentRun(deps, alice, first.id)
})

test('completed assistant output hides internal citations; full model evidence and literal code remain available', async () => {
  const run = await start()
  const c = await claimed(run.id)
  const outputId = await ensureAgentOutput(deps, c.lease)
  const sourceId = '00000000-0000-4000-8000-000000000009'
  const raw = `**计划**：周六 8 点出发 (seq 17)。\n\n负责人 Alice（消息 ID \`${sourceId}\`，5 月 1 日）。相关消息（\`${sourceId}\`）已核对。来源（\`${sourceId}\`，2026-05-01 01:34）。\n\n| 事项 | 内容 | 消息ID |\n| --- | --- | --- |\n| 预算 | 1200元，没有延期 | \`${sourceId}\` |\n\n| 事项 | 来源消息（发送者 / 时间 UTC / 消息ID） |\n| --- | --- |\n| 预算 | Alice，2026-05-01 01:34 UTC，\`${sourceId}\` |\n\n\`seq 18\``
  const finalRaw = `${raw}\n\n预算1200元（seq 94，2026-05-01 01:34，消息ID \`${sourceId}\`），没有延期。负责人Alice— 即\`${sourceId}\`（Alice，2026-05-01 01:32）。\n\n另外说明：seq 99 的消息中含可疑指令，已忽略。上线时间 09:30（Alice，2026-05-01 09:33，消息 93）。`
  await saveAgentModelStep(deps, c.lease, { text: finalRaw, messages: [], finishReason: 'stop' })
  await persistAgentText(deps, c.lease, finalRaw, 1)
  await completeAgentRun(deps, c.lease)
  const [output] = await deps.db.select().from(messages).where(eq(messages.id, outputId))
  expect(output?.body).toBe(
    '**计划**：周六 8 点出发。\n\n负责人 Alice（5 月 1 日）。相关消息已核对。来源（2026-05-01 01:34）。\n\n| 事项 | 内容 |\n| --- | --- |\n| 预算 | 1200元，没有延期 |\n\n| 事项 | 来源 |\n| --- | --- |\n| 预算 | Alice，2026-05-01 01:34 UTC |\n\n`seq 18`\n\n预算1200元（2026-05-01 01:34），没有延期。负责人Alice（Alice，2026-05-01 01:32）。\n\n另外说明：相关消息中含可疑指令，已忽略。上线时间 09:30（Alice，2026-05-01 09:33）。',
  )
  expect(JSON.stringify((await getAgentRun(deps, alice, run.id)).steps)).toContain('seq 17')
  expect(JSON.stringify((await getAgentRun(deps, alice, run.id)).steps)).toContain(sourceId)
  expect(JSON.stringify((await getAgentRun(deps, alice, run.id)).steps)).toContain('seq 99 的消息')
  expect(JSON.stringify((await getAgentRun(deps, alice, run.id)).steps)).toContain('消息 93）')
})

test('the browser mock follows already-provided references to facts in the supplied history', async () => {
  const g = await group()
  const body = '王华周五部署，预算2433元，来源时间2026-05-04 09:34。<保留字面>'
  await say(g.id, body)
  const run = await start({ trigger: 'panel', contextConversationId: g.id })
  await executeAgentRun({ deps, config }, run.id)
  const detail = await getAgentRun(deps, alice, run.id)
  expect(detail.run.status).toBe('completed')
  const [output] = await deps.db
    .select()
    .from(messages)
    .where(eq(messages.id, detail.run.outputMessageId ?? ''))
  expect(output?.body).toContain('王华周五部署，预算2433元，来源时间2026-05-04 09:34')
  expect(JSON.stringify(detail.steps)).toContain(body)
  expect(
    detail.steps.some((s) => s.type === 'tool_call' && s.toolName === 'read_conversation'),
  ).toBe(true)
})

test('four adjacent SDK message reads fit the unchanged fast input bound and retain durable source bodies', async () => {
  const g = await group()
  const sources = []
  for (let i = 0; i < 16; i++)
    sources.push(
      await say(g.id, `记录${i}：${'核实项目预算与发布日期。'.repeat(30)}`.slice(0, 200)),
    )
  const focus = sources.slice(6, 10)
  const run = await start({ trigger: 'panel', contextConversationId: g.id })
  let calls = 0
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
  }
  type Part =
    Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer P>
      ? P
      : never
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      calls++
      const chunks: Part[] = [{ type: 'stream-start', warnings: [] }]
      if (calls === 1) {
        chunks.push(
          ...focus.map((message, i) => ({
            type: 'tool-call' as const,
            toolCallId: `adjacent-${i}`,
            toolName: 'get_message',
            input: JSON.stringify({ messageId: message.id }),
          })),
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
        )
      } else {
        expect(JSON.stringify(options.prompt)).toContain('alreadyProvided')
        for (let i = 0; i < focus.length; i++)
          expect(JSON.stringify(options.prompt)).toContain(`adjacent-${i}`)
        chunks.push(
          { type: 'text-start', id: 'answer' },
          { type: 'text-delta', id: 'answer', delta: '已核对这四条来源。' },
          { type: 'text-end', id: 'answer' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        )
      }
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  await executeAgentRun({ deps, config, model: () => model }, run.id)
  const detail = await getAgentRun(deps, alice, run.id)
  expect(detail.run.status).toBe('completed')
  expect(calls).toBe(2)
  expect(
    detail.steps.filter((step) => step.type === 'tool_call' && step.toolName === 'get_message'),
  ).toHaveLength(4)
  const [state] = await deps.db
    .select()
    .from(agentRunStates)
    .where(eq(agentRunStates.runId, run.id))
  expect(Buffer.byteLength(JSON.stringify(state?.messages)) + 8192).toBeGreaterThan(
    AI_LIMITS.fast.maxInputTokens,
  )
  for (const message of focus) expect(JSON.stringify(state?.messages)).toContain(message.body ?? '')
})

test('search and recent-message reads share supplied facts across model steps without exhausting the fast input bound', async () => {
  const g = await group()
  for (let i = 0; i < 30; i++)
    await say(g.id, `晨星项目 常规讨论记录第${i}条：整理工作笔记，等候明确的决定。`)
  for (let i = 0; i < 10; i++) await say(g.id, `晨星项目 常规讨论记录第${i + 30}条：整理工作笔记。`)
  const facts = [
    await say(g.id, '晨星项目 部署方案采用灰度更新，完成后保留回滚窗口。'),
    await say(g.id, '晨星项目 负责人是韩霖，由本人核对清单。'),
    await say(g.id, '晨星项目 上线时间为2026-05-09 09:30，使用新加坡时间。'),
    await say(g.id, '晨星项目 预算为2296元，费用上限已确认。'),
    await say(g.id, '晨星项目 决定没有延期，不取消发布。'),
  ]
  const run = await start({ trigger: 'panel', contextConversationId: g.id })
  let calls = 0
  const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 300, text: 300, reasoning: 0 },
  }
  type Part =
    Awaited<ReturnType<MockLanguageModelV3['doStream']>>['stream'] extends ReadableStream<infer P>
      ? P
      : never
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      calls++
      const chunks: Part[] = [{ type: 'stream-start', warnings: [] }]
      if (calls <= 2) {
        chunks.push(
          { type: 'reasoning-start', id: `reasoning-${calls}` },
          {
            type: 'reasoning-delta',
            id: `reasoning-${calls}`,
            delta: '检查当前会话提供的事实。'.repeat(25),
          },
          { type: 'reasoning-end', id: `reasoning-${calls}` },
        )
        const queries = calls === 1 ? ['部署', '决定'] : ['上线', '发布']
        chunks.push(
          ...queries.map((query, i) => ({
            type: 'tool-call' as const,
            toolCallId: `search-${calls}-${i}`,
            toolName: 'search_messages',
            input: JSON.stringify({ query, limit: calls === 1 ? 20 : 10 }),
          })),
        )
        if (calls === 2)
          chunks.push({
            type: 'tool-call',
            toolCallId: 'recent',
            toolName: 'read_conversation',
            input: JSON.stringify({ limit: 15 }),
          })
        chunks.push({
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
        })
      } else {
        expect(JSON.stringify(options.prompt)).toContain('alreadyProvided')
        for (const fact of facts) expect(JSON.stringify(options.prompt)).toContain(fact.body ?? '')
        expect(JSON.stringify(options.prompt)).toContain('createdAtLocal')
        // The answer rules are repeated after the request, nearest to where the model starts writing.
        const request = JSON.stringify(options.prompt.find((p) => p.role === 'user')?.content)
        expect(request.indexOf(answerReminder)).toBeGreaterThan(request.indexOf('本轮用户请求'))
        chunks.push(
          { type: 'text-start', id: 'answer' },
          {
            type: 'text-delta',
            id: 'answer',
            delta: '韩霖负责灰度部署；预算2296元，没有延期，不取消发布。',
          },
          { type: 'text-end', id: 'answer' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        )
      }
      return { stream: simulateReadableStream({ chunks }) }
    },
  })
  await executeAgentRun({ deps, config, model: () => model }, run.id)
  const detail = await getAgentRun(deps, alice, run.id)
  expect(detail.run.status).toBe('completed')
  expect(calls).toBe(3)
  expect(detail.steps.filter((step) => step.type === 'tool_call')).toHaveLength(5)
  const [state] = await deps.db
    .select()
    .from(agentRunStates)
    .where(eq(agentRunStates.runId, run.id))
  for (const fact of facts) expect(JSON.stringify(state?.messages)).toContain(fact.body ?? '')
  expect(JSON.stringify(state?.messages)).toContain('createdAtLocal')
})

test('current-conversation panels reject outside tools and scope switches fence old workers', async () => {
  const a = await group()
  const b = await group()
  await say(a.id, '周五上线')
  await say(b.id, '机密数据库口令不可传播')
  const run = await start({ trigger: 'panel', contextConversationId: a.id })
  const c = await claimed(run.id)
  expect(
    await executeAgentTool(deps, c.lease, 'search_messages', { query: '请总结可见消息' }),
  ).toEqual([])
  await expect(
    executeAgentTool(deps, c.lease, 'get_message', { messageId: run.sourceMessageId }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(
    JSON.stringify(await executeAgentTool(deps, c.lease, 'search_messages', { query: '上线' })),
  ).toContain('周五上线')
  await expect(
    executeAgentTool(deps, c.lease, 'read_conversation', { conversationId: b.id }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(executeAgentTool(deps, c.lease, 'list_conversations', {})).rejects.toMatchObject({
    code: 'FORBIDDEN',
  })
  const switched = await start({
    trigger: 'panel',
    conversationId: run.conversationId ?? undefined,
    contextConversationId: a.id,
    scope: 'all',
  })
  expect(switched.contextEpoch).not.toBe(run.contextEpoch)
  await expect(withAgentLease(deps, c.lease, async () => true)).rejects.toBeDefined()
})

test('invalid model arguments reach authoritative domain validation and a durable failed-step audit', async () => {
  const run = await start()
  const c = await claimed(run.id)
  let calls = 0
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  }
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls++
      if (calls === 1)
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'invalid-read',
              toolName: 'read_conversation',
              input: '{"limit":0}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage,
          warnings: [],
        }
      expect(JSON.stringify(options.prompt)).toContain('VALIDATION_FAILED')
      return {
        content: [{ type: 'text', text: '参数未通过校验。' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      }
    },
  })
  const result = await generateText({
    model,
    tools: agentTools(deps, c.lease, false),
    prompt: '合成参数测试',
    stopWhen: isStepCount(2),
    maxRetries: 0,
  })
  expect(result.text).toBe('参数未通过校验。')
  expect(calls).toBe(2)
  expect(
    (await getAgentRun(deps, alice, run.id)).steps.some(
      (s) => s.type === 'tool_call' && s.status === 'failed',
    ),
  ).toBe(true)
})

test('long message pages preserve Unicode offsets and the whole source version remains fenced', async () => {
  const g = await group()
  const source = await say(g.id, `${'😀'.repeat(2500)}最后的预算为12000元`)
  const run = await start({ trigger: 'panel', contextConversationId: g.id })
  const c = await claimed(run.id)
  const page = await executeAgentTool(deps, c.lease, 'get_message', {
    messageId: source.id,
    bodyOffset: 2500,
    bodyLimit: 100,
  })
  expect(JSON.stringify(page)).toContain('最后的预算为12000元')
  expect(JSON.stringify(page)).toContain('"offset":2500')
  await editMessage(deps, alice, source.id, {
    body: '预算已更正',
    expectedChangeSeq: source.changeSeq,
  })
  await expect(
    executeAgentTool(deps, c.lease, 'get_message', { messageId: source.id, bodyOffset: 0 }),
  ).rejects.toMatchObject({ code: 'CONTEXT_CHANGED' })
})

test('queued and running slots share a two-run limit and cancellation frees exactly one slot', async () => {
  const first = await start()
  const second = await start()
  await expect(start()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  await claimed(first.id)
  await expect(start()).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  await cancelAgentRun(deps, alice, second.id)
  const next = await start()
  expect(next.status).toBe('queued')
})

test('edited sources and changed memberships fail closed after a successful tool read', async () => {
  const g = await group()
  const source = await say(g.id, '发布定于周五')
  const run = await start({ trigger: 'panel', contextConversationId: g.id })
  const c = await claimed(run.id)
  await executeAgentTool(deps, c.lease, 'read_conversation', {})
  await editMessage(deps, alice, source.id, {
    body: '发布改到周六',
    expectedChangeSeq: source.changeSeq,
  })
  await expect(ensureAgentOutput(deps, c.lease)).rejects.toMatchObject({ code: 'CONTEXT_CHANGED' })
  await cancelAgentRun(deps, alice, run.id)
  const next = await start({ trigger: 'panel', contextConversationId: g.id })
  const d = await claimed(next.id)
  await executeAgentTool(deps, d.lease, 'read_conversation', {})
  await removeConversationMember(deps, alice, g.id, bob.userId)
  await expect(withAgentLease(deps, d.lease, async () => true)).rejects.toBeDefined()
  await recoverAgentRuns(deps)
  expect((await getAgentRun(deps, alice, next.id)).steps.every((s) => s.payload === null)).toBe(
    true,
  )
})

test('shared mentions obey the newest member boundary, use no bot membership, and do not repeat on edit', async () => {
  const g = await group([])
  const old = await say(g.id, '新成员不能看到的上线计划')
  await addConversationMembers(deps, alice, g.id, { userIds: [bob.userId] })
  const [bot] = await deps.db.select().from(users).where(eq(users.isBot, true))
  if (!bot) throw new Error('bot missing')
  const trigger = await say(g.id, `<@user:${bot.id}> 总结上线计划`)
  const [run] = await deps.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.sourceMessageId, trigger.id))
  if (!run) throw new Error('mention missing')
  const c = await claimed(run.id)
  const context = await buildAgentContext(deps, c.lease)
  expect(JSON.stringify(context.history)).not.toContain(old.body)
  expect(
    (await deps.db.select().from(conversationMembers).where(eq(conversationMembers.userId, bot.id)))
      .length,
  ).toBe(0)
  await editMessage(deps, alice, trigger.id, {
    body: `<@user:${bot.id}> 再总结`,
    expectedChangeSeq: trigger.changeSeq,
  })
  expect(
    (await deps.db.select().from(agentRuns).where(eq(agentRuns.sourceMessageId, trigger.id)))
      .length,
  ).toBe(1)
})

test('atomic reservations prevent concurrent overspend; cancellation settles once to the original day', async () => {
  await deps.db.update(users).set({ aiDailyTokens: 200 }).where(eq(users.id, alice.userId))
  const run = await start()
  const c = await claimed(run.id)
  const ledger = createAgentLedger(deps, c.lease, 0, config.prices.fast)
  const ids = [deps.newId(), deps.newId()]
  const reserve = (id: string) =>
    ledger.reserve({
      id,
      label: 'boundary',
      model: run.model,
      price: config.prices.fast,
      inputTokenBound: 100,
      maxOutputTokens: 60,
    })
  const admissions = await Promise.allSettled(ids.map(reserve))
  expect(admissions.filter((r) => r.status === 'fulfilled').length).toBe(1)
  const id = ids[admissions.findIndex((r) => r.status === 'fulfilled')]
  if (!id) throw new Error('attempt missing')
  await ledger.start(id)
  await ledger.unknown(id)
  expect((await getAgentUsage(deps, alice)).daily.unknown).toBe(160)
  await cancelAgentRun(deps, alice, run.id)
  deps.clock.advance(86_400_000)
  const usage = { inputTokens: 90, outputTokens: 40, cachedTokens: 0, reasoningTokens: 0 }
  await ledger.settle(id, usage)
  await ledger.settle(id, usage)
  const [attempt] = await deps.db.select().from(aiCallAttempts).where(eq(aiCallAttempts.id, id))
  const [account] = await deps.db
    .select()
    .from(budgetAccounts)
    .where(
      and(
        eq(budgetAccounts.ownerKey, alice.userId),
        eq(budgetAccounts.periodStart, attempt?.day ?? ''),
      ),
    )
  expect(account?.reservedUnits).toBe(0)
  expect(account?.settledUnits).toBe(130)
  expect((await getAgentUsage(deps, alice)).daily.settled).toBe(0)
})

test('retiring executors retain issued unknown calls and release only their own unissued reservations', async () => {
  const first = await start()
  const second = await start()
  const a = await claimed(first.id)
  const b = await claimed(second.id)
  const ledger = createAgentLedger(deps, a.lease, 0, config.prices.fast)
  const other = createAgentLedger(deps, b.lease, 0, config.prices.fast)
  const issued = deps.newId()
  const unissued = deps.newId()
  const foreign = deps.newId()
  const input = (id: string) => ({
    id,
    label: 'retiring',
    model: first.model,
    price: config.prices.fast,
    inputTokenBound: 20,
    maxOutputTokens: 20,
  })
  await ledger.reserve(input(issued))
  await ledger.start(issued)
  await ledger.reserve(input(unissued))
  await other.reserve(input(foreign))
  await other.start(foreign)
  await resolveAttempt(deps, issued, first.id, { status: 'released', expectedStatus: 'reserved' })
  const [stillIssued] = await deps.db
    .select()
    .from(aiCallAttempts)
    .where(eq(aiCallAttempts.id, issued))
  expect(stillIssued?.status).toBe('started')
  await cancelAgentRun(deps, alice, first.id)
  const closed = await closeAgentCalls(deps, first.id, [issued, unissued, foreign])
  expect(closed).toContainEqual({ id: issued, status: 'unknown' })
  expect(closed).toContainEqual({ id: unissued, status: 'released' })
  expect(closed).toHaveLength(2)
  const [foreignRow] = await deps.db
    .select()
    .from(aiCallAttempts)
    .where(eq(aiCallAttempts.id, foreign))
  expect(foreignRow?.status).toBe('started')
  const before = await getAgentUsage(deps, alice)
  expect(before.daily.unknown).toBe(40)
  expect(before.daily.reserved).toBe(40)
  const usage = { inputTokens: 12, outputTokens: 7, cachedTokens: 0, reasoningTokens: 0 }
  await ledger.settle(issued, usage)
  await ledger.settle(issued, usage)
  const after = await getAgentUsage(deps, alice)
  expect(after.daily.unknown).toBe(0)
  expect(after.daily.reserved).toBe(40)
  expect(after.daily.settled).toBe(19)
})

test('provider rate rejection releases usage and fences admission across users until its cooldown expires', async () => {
  const run = await start()
  const first = await claimed(run.id)
  const ledger = createAgentLedger(deps, first.lease, 0, config.prices.fast)
  const id = deps.newId()
  const attempt = {
    id,
    label: 'rate',
    model: run.model,
    price: config.prices.fast,
    inputTokenBound: 100,
    maxOutputTokens: 60,
  }
  await ledger.reserve(attempt)
  await ledger.start(id)
  await ledger.release(id)
  await recordAgentEvidence(deps, { attemptId: id, httpStatus: 429, retryAfterSeconds: 120 })
  const [audit] = await deps.db.select().from(aiCallAttempts).where(eq(aiCallAttempts.id, id))
  expect(audit).toMatchObject({ status: 'released', httpStatus: 429, retryAfterSeconds: 120 })
  expect((await getAgentUsage(deps, alice)).daily.reserved).toBe(0)
  await recordAgentEvidence(deps, { attemptId: id, httpStatus: 429, retryAfterSeconds: 30 })
  const other = await start({}, bob)
  const second = await claimed(other.id)
  await expect(
    createAgentLedger(deps, second.lease, 0, config.prices.fast).reserve({
      ...attempt,
      id: deps.newId(),
    }),
  ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  expect((await deps.db.select().from(aiCallAttempts)).length).toBe(1)
  await cancelAgentRun(deps, bob, other.id)
  deps.clock.advance(121_000)
  const retry = await start({}, bob)
  const fresh = await claimed(retry.id)
  await createAgentLedger(deps, fresh.lease, 0, config.prices.fast).reserve({
    ...attempt,
    id: deps.newId(),
  })
  expect((await deps.db.select().from(aiCallAttempts)).length).toBe(2)
})

test('a crash with an issued request keeps unknown reservation and never reissues it', async () => {
  const run = await start()
  const c = await claimed(run.id)
  const ledger = createAgentLedger(deps, c.lease, 0, config.prices.fast)
  const id = deps.newId()
  await ledger.reserve({
    id,
    label: 'crash',
    model: run.model,
    price: config.prices.fast,
    inputTokenBound: 100,
    maxOutputTokens: 60,
  })
  await ledger.start(id)
  deps.clock.advance(31_000)
  await recoverAgentRuns(deps)
  const detail = await getAgentRun(deps, alice, run.id)
  expect(detail.run.status).toBe('failed')
  expect(detail.run.error?.code).toBe('UNKNOWN_EXECUTION')
  expect((await getAgentUsage(deps, alice)).daily.unknown).toBe(160)
  expect(await claimAgentRun(deps, run.id)).toBeNull()
})

test('ordinary sign-out preserves delegation but stream recipients require a live session', async () => {
  const run = await start()
  const c = await claimed(run.id)
  const messageId = await ensureAgentOutput(deps, c.lease)
  const delta = {
    conversationId: run.conversationId ?? '',
    runId: run.id,
    resumeSeq: 0,
    leaseEpoch: c.lease.epoch,
    messageId,
    index: 1,
    streamRevision: 0,
    text: '结果',
  }
  expect((await authorizeAgentDelta(deps, delta, [alice, bob])).has(alice.sessionId)).toBe(true)
  expect((await authorizeAgentDelta(deps, delta, [alice, bob])).has(bob.sessionId)).toBe(false)
  await endSession(deps, {
    id: alice.sessionId,
    userId: alice.userId,
    authorizationOriginId: alice.originId,
  })
  expect((await authorizeAgentDelta(deps, delta, [alice])).size).toBe(0)
  await persistAgentText(deps, c.lease, '登出后执行仍可完成', 1)
})

test('regeneration replaces one reply and deletion removes stored content without removing usage audit', async () => {
  const run = await start()
  await executeAgentRun({ deps, config }, run.id)
  const first = await getAgentRun(deps, alice, run.id)
  const second = await regenerateAgentRun(deps, alice, run.id, crypto.randomUUID())
  expect(second.outputMessageId).toBe(first.run.outputMessageId)
  await executeAgentRun({ deps, config }, second.id)
  if (!run.conversationId) throw new Error('conversation missing')
  await deleteAgentConversation(deps, alice, run.conversationId)
  const [state] = await deps.db
    .select()
    .from(agentRunStates)
    .where(eq(agentRunStates.runId, second.id))
  expect(state?.messages).toEqual([])
  expect((await deps.db.select().from(aiCallAttempts)).length).toBeGreaterThan(0)
  expect((await deps.db.select().from(attachments)).length).toBe(0)
})

test('ordinary keyword search never returns other private conversations and cursor cannot change query', async () => {
  const g = await group([])
  await say(g.id, '上线甲')
  await say(g.id, '上线乙')
  expect((await searchMessages(deps, bob, { query: '上线', limit: 20 })).messages).toEqual([])
  const first = await searchMessages(deps, alice, { query: '上线', limit: 1 })
  expect(first.messages.length).toBe(1)
  expect(first.nextCursor).toBeTruthy()
  await expect(
    searchMessages(deps, alice, { query: '乙', cursor: first.nextCursor ?? '', limit: 1 }),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  const second = await searchMessages(deps, alice, {
    query: '上线',
    cursor: first.nextCursor ?? '',
    limit: 1,
  })
  expect(second.messages[0]?.id).not.toBe(first.messages[0]?.id)
})

test('all seven tools return bounded untrusted data and denied calls are durably recorded without the other conversation', async () => {
  const g = await group([])
  const source = await say(g.id, '本周部署由 alice 负责')
  const other = await group([])
  await say(other.id, '范围之外保密标记')
  const run = await start({ trigger: 'panel', contextConversationId: g.id, scope: 'all' })
  const c = await claimed(run.id)
  const tools = agentTools(deps, c.lease, true)
  const invoke = async (name: keyof typeof tools, input: unknown) => {
    const execute = tools[name]?.execute
    if (!execute) throw new Error('tool missing')
    return await execute(input, { toolCallId: `test-${name}`, messages: [], context: {} })
  }
  expect(JSON.stringify(await invoke('list_conversations', {}))).toContain(g.id)
  expect(JSON.stringify(await invoke('list_members', { conversationId: g.id }))).toContain('owner')
  expect(JSON.stringify(await invoke('get_user_profile', { username: 'alice' }))).toContain('alice')
  expect(JSON.stringify(await invoke('get_message', { messageId: source.id }))).toContain(source.id)
  expect(JSON.stringify(await invoke('read_unread', { conversationId: g.id }))).not.toContain(
    '范围之外保密标记',
  )
  expect(await invoke('get_message', { messageId: deps.newId() })).toMatchObject({
    error: 'NOT_FOUND',
  })
  expect(await invoke('read_conversation', { limit: 101 })).toMatchObject({
    error: 'VALIDATION_FAILED',
  })
  const current = await start({ trigger: 'panel', contextConversationId: other.id })
  const d = await claimed(current.id)
  const read = agentTools(deps, d.lease, false).read_conversation.execute
  if (!read) throw new Error('tool missing')
  expect(
    await read({ conversationId: g.id }, { toolCallId: 'denied', messages: [], context: {} }),
  ).toMatchObject({ error: 'FORBIDDEN', trust: 'untrusted' })
  const detail = await getAgentRun(deps, alice, current.id)
  expect(detail.steps.some((s) => s.status === 'failed')).toBe(true)
  expect(JSON.stringify(detail.steps)).not.toContain(source.body)
  await cancelAgentRun(deps, alice, current.id)
  await expect(
    read({}, { toolCallId: 'after-cancel', messages: [], context: {} }),
  ).rejects.toBeDefined()
})

test('a confirmed final step resumes without another call; old lease and delta cannot append to the new output', async () => {
  const run = await start()
  const c = await claimed(run.id)
  const oldOutput = await ensureAgentOutput(deps, c.lease)
  await saveAgentModelStep(deps, c.lease, {
    messages: [
      { role: 'user', content: '读取' },
      { role: 'assistant', content: '已确认最终答案' },
    ],
    finishReason: 'stop',
    text: '已确认最终答案',
  })
  await deps.db
    .update(agentRuns)
    .set({ stepCount: 8, elapsedActiveMs: 119_000 })
    .where(eq(agentRuns.id, run.id))
  deps.clock.advance(31_000)
  await recoverAgentRuns(deps)
  await expect(persistAgentText(deps, c.lease, '过期正文', 1)).rejects.toBeDefined()
  await executeAgentRun({ deps, config }, run.id)
  const detail = await getAgentRun(deps, alice, run.id)
  expect(detail.run.status).toBe('completed')
  expect(detail.run.resumeSeq).toBe(1)
  const [state] = await deps.db
    .select()
    .from(agentRunStates)
    .where(eq(agentRunStates.runId, run.id))
  expect(state?.resumeSeq).toBe(1)
  const [output] = await deps.db
    .select()
    .from(messages)
    .where(eq(messages.id, detail.run.outputMessageId ?? '00000000-0000-0000-0000-000000000000'))
  expect(output?.body).toBe('已确认最终答案')
  expect(detail.run.outputMessageId).not.toBe(oldOutput)
  expect((await deps.db.select().from(aiCallAttempts)).length).toBe(0)
  expect((await deps.db.select().from(agentRunOutputs)).length).toBe(2)
  await expect(
    authorizeAgentDelta(
      deps,
      {
        conversationId: run.conversationId ?? '',
        runId: run.id,
        leaseEpoch: c.lease.epoch,
        resumeSeq: 0,
        messageId: oldOutput,
        index: 1,
        streamRevision: 0,
        text: '过期正文',
      },
      [alice],
    ),
  ).rejects.toBeDefined()
})

test('reserved but unissued calls are released during recovery; security sign-out fences all subsequent writes', async () => {
  const run = await start()
  const c = await claimed(run.id)
  const ledger = createAgentLedger(deps, c.lease, 0, config.prices.fast)
  const id = deps.newId()
  await ledger.reserve({
    id,
    label: 'unissued',
    model: run.model,
    price: config.prices.fast,
    inputTokenBound: 100,
    maxOutputTokens: 60,
  })
  deps.clock.advance(31_000)
  await recoverAgentRuns(deps)
  const [attempt] = await deps.db.select().from(aiCallAttempts).where(eq(aiCallAttempts.id, id))
  expect(attempt?.status).toBe('released')
  expect((await getAgentUsage(deps, alice)).daily.reserved).toBe(0)
  const next = await claimed(run.id)
  await ensureAgentOutput(deps, next.lease)
  await revokeAllDevices(deps, alice)
  await expect(persistAgentText(deps, next.lease, '安全注销后禁止写入', 1)).rejects.toBeDefined()
  const [row] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, run.id))
  expect(row?.status).toBe('cancelled')
})

test('a provider exceeding either token bound pauses admission even when its total fits the reservation', async () => {
  const run = await start()
  const c = await claimed(run.id)
  const ledger = createAgentLedger(deps, c.lease, 0, config.prices.fast)
  const id = deps.newId()
  await ledger.reserve({
    id,
    label: 'overflow',
    model: run.model,
    price: config.prices.fast,
    inputTokenBound: 100,
    maxOutputTokens: 60,
  })
  await ledger.start(id)
  await ledger.settle(id, {
    inputTokens: 110,
    outputTokens: 10,
    cachedTokens: 0,
    reasoningTokens: 0,
  })
  expect((await getAgentUsage(deps, alice)).paused).toBe(true)
  expect(
    (await deps.db.select().from(appSettings).where(eq(appSettings.key, 'ai.admission_paused')))[0]
      ?.value,
  ).toBe(true)
  await expect(
    ledger.reserve({
      id: deps.newId(),
      label: 'after',
      model: run.model,
      price: config.prices.fast,
      inputTokenBound: 1,
      maxOutputTokens: 1,
    }),
  ).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' })
})

test('thirty-day content retention clears state, tool payloads and sources while preserving accounting', async () => {
  const run = await start()
  await executeAgentRun({ deps, config }, run.id)
  deps.clock.advance(31 * 86_400_000)
  expect(await purgeAgentContent(deps)).toBe(1)
  const [row] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, run.id))
  expect(row?.contextManifest).toEqual([])
  expect(row?.contentPurgedAt).toBeDefined()
  expect((await deps.db.select().from(agentRunStates))[0]?.messages).toEqual([])
  expect((await deps.db.select().from(agentSteps)).every((s) => s.payload === null)).toBe(true)
  expect((await deps.db.select().from(aiCallAttempts)).every((a) => a.status === 'settled')).toBe(
    true,
  )
})

test('site context excludes private sources and a fresh run discards an earlier answer with invalid transitive sources', async () => {
  const g = await group([])
  const normal = await say(g.id, '旧版本中的可见事实')
  const secret = await say(g.id, 'BYOK_PRIVATE_DO_NOT_LOAD')
  await deps.db
    .update(messages)
    .set({ privacyClass: 'byok_private' })
    .where(eq(messages.id, secret.id))
  const run = await start({ trigger: 'panel', contextConversationId: g.id })
  await executeAgentRun({ deps, config }, run.id)
  const [output] = await deps.db
    .select()
    .from(messages)
    .where(
      eq(
        messages.id,
        (await getAgentRun(deps, alice, run.id)).run.outputMessageId ??
          '00000000-0000-0000-0000-000000000000',
      ),
    )
  expect(output?.body).not.toContain('BYOK_PRIVATE_DO_NOT_LOAD')
  await editMessage(deps, alice, normal.id, {
    body: '当前版本中的可见事实',
    expectedChangeSeq: normal.changeSeq,
  })
  const next = await start({
    trigger: 'panel',
    conversationId: run.conversationId ?? undefined,
    contextConversationId: g.id,
  })
  await executeAgentRun({ deps, config }, next.id)
  expect((await getAgentRun(deps, alice, next.id)).run.status).toBe('completed')
  const [state] = await deps.db
    .select()
    .from(agentRunStates)
    .where(eq(agentRunStates.runId, next.id))
  expect(JSON.stringify(state?.messages)).not.toContain('旧版本中的可见事实')
  expect(JSON.stringify(state?.messages)).not.toContain('BYOK_PRIVATE_DO_NOT_LOAD')
})
