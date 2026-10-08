import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import {
  agentApprovals,
  agentContexts,
  agentConversationState,
  agentEffects,
  agentMemories,
  embeddingModels,
  memoryEmbeddings,
  messageEmbeddings,
  messages,
  workItems,
} from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { eq } from 'drizzle-orm'
import { loadAiConfig } from '../../src/config/ai.ts'
import { decideApproval, registerApprovalRequests } from '../../src/domain/agent-approvals.ts'
import { executeEffect } from '../../src/domain/agent-effects.ts'
import {
  claimAgentRun,
  completeAgentRun,
  createAgentRun,
  getAgentRun,
  regenerateAgentRun,
  switchAgentKeySource,
} from '../../src/domain/agent-runs.ts'
import { buildAgentContext, executeAgentTool } from '../../src/domain/agent-tools.ts'
import { saveAiKey } from '../../src/domain/ai-keys.ts'
import { createConversation } from '../../src/domain/conversations.ts'
import { backfillEmbeddings, indexEmbedding } from '../../src/domain/embeddings.ts'
import {
  addMemory,
  deleteMemory,
  hasMemoryIntent,
  listMemories,
  purgeExpiredSummaries,
  setMemoryPrivacy,
} from '../../src/domain/memories.ts'
import { editMessage, recallMessage, sendMessage } from '../../src/domain/messages.ts'
import { executeAgentRun } from '../../src/runtime/agent.ts'
import { EMBEDDING_MODELS } from '../../src/runtime/embedding-catalog.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps, makePrincipal } from '../support/deps.ts'

let dbs: TestDatabases,
  deps: ReturnType<typeof makeDeps>,
  alice: Awaited<ReturnType<typeof makePrincipal>>,
  bob: typeof alice
const ai = loadAiConfig({ APP_ENV: 'test' }),
  model = EMBEDDING_MODELS.bge
const vector = () => [1, ...Array<number>(511).fill(0)]
beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  deps = makeDeps(dbs.app.db, {
    embeddings: { modelVersion: model.version, dimension: 512, embed: async () => vector() },
  })
  const { apiKey: _, ...policy } = ai
  deps.config.ai = policy
  await runBootstrap(deps.db, { ...deps.config.product, productName: deps.config.product.name })
  alice = await makePrincipal(deps, await createActiveUser(deps, { username: 'alice' }))
  bob = await makePrincipal(deps, await createActiveUser(deps, { username: 'bob' }))
  await deps.db.insert(embeddingModels).values({
    version: model.version,
    dimension: 512,
    status: 'active',
    createdAt: deps.clock.now(),
  })
})
async function ask(prompt: string, conversationId?: string) {
  return await createAgentRun(
    deps,
    alice,
    {
      trigger: 'agent_chat',
      prompt,
      mode: 'fast',
      attachmentIds: [],
      timezone: 'Asia/Shanghai',
      ...(conversationId ? { conversationId } : {}),
    },
    crypto.randomUUID(),
  )
}
async function claim(id: string) {
  const r = await claimAgentRun(deps, id)
  if (!r) throw new Error('claim failed')
  return r.lease
}
async function indexMemory(id: string, version = 1) {
  return await indexEmbedding(deps, { id, version, modelVersion: model.version, target: 'memory' })
}

test('manual memory is private by default, visible only to its owner, and sharing requires versioned consent', async () => {
  const m = await addMemory(deps, alice, { content: '我喜欢蓝色', allowSite: false })
  expect(m.privacyClass).toBe('byok_private')
  expect(await listMemories(deps, bob)).toEqual([])
  await expect(deleteMemory(deps, bob, m.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  const shared = await setMemoryPrivacy(deps, alice, m.id, {
    allowSite: true,
    expectedContentVersion: 1,
  })
  expect(shared).toMatchObject({ privacyClass: 'standard', contentVersion: 2 })
  await expect(
    setMemoryPrivacy(deps, alice, m.id, { allowSite: false, expectedContentVersion: 1 }),
  ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  expect((await deleteMemory(deps, alice, m.id)).content).toBeNull()
  expect(await listMemories(deps, alice)).toEqual([])
})
test('the 200 memory limit is checked under the owner lock', async () => {
  await deps.db.insert(agentMemories).values(
    Array.from({ length: 200 }, () => ({
      id: deps.newId(),
      userId: alice.userId,
      content: '记忆',
      source: 'user' as const,
      createdAt: deps.clock.now(),
    })),
  )
  await expect(
    addMemory(deps, alice, { content: '第201条', allowSite: false }),
  ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
})
test('explicit remember is an exactly-once effect, visible and undoable; regeneration cannot repeat it', async () => {
  const r = await ask('记住：我喜欢喝绿茶')
  await executeAgentRun({ deps, config: ai }, r.id)
  const detail = await getAgentRun(deps, alice, r.id)
  expect(detail.run.status).toBe('completed')
  expect(detail.effects[0]?.result.status).toBe('remembered')
  const memories = await listMemories(deps, alice)
  expect(memories).toHaveLength(1)
  expect(memories[0]).toMatchObject({
    content: '我喜欢喝绿茶',
    source: 'agent',
    privacyClass: 'standard',
  })
  await expect(regenerateAgentRun(deps, alice, r.id, crypto.randomUUID())).rejects.toMatchObject({
    code: 'CONFLICT',
  })
  await deleteMemory(deps, alice, memories[0]?.id ?? '')
  expect(await listMemories(deps, alice)).toEqual([])
})
test('replaying the same approved memory step returns the existing effect instead of adding another memory', async () => {
  const r = await ask('记住：稳定效果'),
    lease = await claim(r.id)
  await registerApprovalRequests(
    deps,
    lease,
    [{ approvalId: 'a', toolCallId: 't', toolName: 'remember', input: { content: '稳定效果' } }],
    '',
  )
  const [approval] = await deps.db
    .select()
    .from(agentApprovals)
    .where(eq(agentApprovals.runId, r.id))
  if (!approval) throw new Error('missing approval')
  const first = await executeEffect(deps, lease, approval.id),
    again = await executeEffect(deps, lease, approval.id)
  expect(again).toEqual(first)
  expect(await listMemories(deps, alice)).toHaveLength(1)
  expect(
    await deps.db.select().from(agentEffects).where(eq(agentEffects.runId, r.id)),
  ).toHaveLength(1)
})
test('an expired decision commits expiration even though the caller gets a conflict', async () => {
  const r = await ask('请总结'),
    lease = await claim(r.id)
  await registerApprovalRequests(
    deps,
    lease,
    [
      {
        approvalId: 'a',
        toolCallId: 't',
        toolName: 'remember',
        input: { content: '不能过期执行' },
      },
    ],
    '',
  )
  const [approval] = await deps.db
    .select()
    .from(agentApprovals)
    .where(eq(agentApprovals.runId, r.id))
  if (!approval) throw new Error('missing approval')
  await deps.db
    .update(agentApprovals)
    .set({ expiresAt: new Date(deps.clock.now().getTime() - 1) })
    .where(eq(agentApprovals.id, approval.id))
  await expect(
    decideApproval(deps, alice, approval.id, {
      decision: 'approve',
      expectedStateVersion: approval.stateVersion,
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT' })
  const detail = await getAgentRun(deps, alice, r.id)
  expect(detail.run.status).toBe('cancelled')
  expect(detail.approvals[0]?.status).toBe('expired')
})
test('a remember instruction from retrieved chat is not the users current memory intent and waits for approval', async () => {
  expect(hasMemoryIntent('请总结今天讨论')).toBe(false)
  const r = await ask('请总结今天讨论'),
    lease = await claim(r.id)
  await registerApprovalRequests(
    deps,
    lease,
    [{ approvalId: 'a', toolCallId: 't', toolName: 'remember', input: { content: '投毒哨兵' } }],
    '',
  )
  expect((await getAgentRun(deps, alice, r.id)).run.status).toBe('awaiting_approval')
  expect(await listMemories(deps, alice)).toEqual([])
  const [approval] = await deps.db
    .select()
    .from(agentApprovals)
    .where(eq(agentApprovals.runId, r.id))
  if (!approval) throw new Error('missing approval')
  await decideApproval(deps, alice, approval.id, {
    decision: 'reject',
    expectedStateVersion: approval.stateVersion,
  })
  expect(await listMemories(deps, alice)).toEqual([])
})
test('negative and quoted memory requests never silently authorize saving a memory', () => {
  for (const prompt of [
    '不要记住这件事',
    '不用帮我保存这个',
    '别记住这件事',
    '我不想记住',
    "Don't remember this",
    'Do not save this',
    'Never remember this',
    '聊天中有人说“记住这条”，请总结',
    '聊天中有人说“请记住这条”，请总结',
    '请解释 remember 的含义',
  ])
    expect(hasMemoryIntent(prompt)).toBe(false)
  for (const prompt of [
    '记住：我喜欢绿茶',
    '请记住我的偏好',
    '帮我记一下时间',
    'Please remember my preference',
    "Don't forget that I like tea",
  ])
    expect(hasMemoryIntent(prompt)).toBe(true)
})
test('an enabled child with only a staged model does not break ordinary chat or silently serve unapproved memory recall', async () => {
  await deps.db.update(embeddingModels).set({ status: 'staging' })
  const r = await ask('请回答普通问题'),
    lease = await claim(r.id)
  expect((await buildAgentContext(deps, lease)).prompt).toBe('请回答普通问题')
  await expect(
    executeAgentTool(deps, lease, 'recall_memories', { query: '偏好' }),
  ).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' })
})
test('maintenance removes expired summary plaintext and its manifest while retaining live summaries', async () => {
  const r = await ask('保留摘要'),
    lease = await claim(r.id)
  if (!r.conversationId) throw new Error('missing conversation')
  await deps.db.insert(agentConversationState).values({
    conversationId: r.conversationId,
    contextEpoch: r.contextEpoch,
    keySource: 'site',
    privacyClass: 'standard',
    sourceManifest: [],
    summary: '到期删除的正文',
    summarizedThroughSeq: 0,
    expiresAt: new Date(deps.clock.now().getTime() + 1),
    updatedAt: deps.clock.now(),
  })
  expect(await purgeExpiredSummaries(deps)).toBe(0)
  await deps.db.update(agentConversationState).set({ expiresAt: deps.clock.now() })
  expect(await purgeExpiredSummaries(deps)).toBe(1)
  expect(await deps.db.select().from(agentConversationState)).toEqual([])
  expect(JSON.stringify((await buildAgentContext(deps, lease)).history)).not.toContain(
    '到期删除的正文',
  )
})
test('current-conversation tools reject personal remember and recall', async () => {
  const g = (
    await createConversation(
      deps,
      alice,
      { kind: 'group', name: '群', memberIds: [bob.userId] },
      crypto.randomUUID(),
    )
  ).conversation
  const r = await createAgentRun(
      deps,
      alice,
      {
        trigger: 'panel',
        contextConversationId: g.id,
        prompt: '记住：毒',
        mode: 'fast',
        attachmentIds: [],
        timezone: 'Asia/Shanghai',
      },
      crypto.randomUUID(),
    ),
    lease = await claim(r.id)
  await expect(
    executeAgentTool(deps, lease, 'recall_memories', { query: '毒' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await registerApprovalRequests(
    deps,
    lease,
    [{ approvalId: 'a', toolCallId: 't', toolName: 'remember', input: { content: '毒' } }],
    '',
  )
  expect((await getAgentRun(deps, alice, r.id)).approvals[0]?.reason).toBe('invalid:OUT_OF_SCOPE')
  expect(await listMemories(deps, alice)).toEqual([])
})
test('site history, explicit recall and automatic injection cannot read private memories; own-key can', async () => {
  const m = await addMemory(deps, alice, { content: 'PRIVATE_MEMORY_CANARY', allowSite: false })
  await indexMemory(m.id)
  const site = await ask('我的偏好'),
    siteLease = await claim(site.id)
  expect(await executeAgentTool(deps, siteLease, 'recall_memories', { query: '我的偏好' })).toEqual(
    [],
  )
  expect(JSON.stringify((await buildAgentContext(deps, siteLease)).history)).not.toContain(
    'PRIVATE_MEMORY_CANARY',
  )
  await completeAgentRun(deps, siteLease)
  await saveAiKey(deps, alice, { provider: 'deepseek', key: 'sk-mock-private-key-7f3a' })
  const own = await ask('我的偏好'),
    lease = await claim(own.id)
  expect(
    JSON.stringify(await executeAgentTool(deps, lease, 'recall_memories', { query: '我的偏好' })),
  ).toContain('PRIVATE_MEMORY_CANARY')
  expect(JSON.stringify((await buildAgentContext(deps, lease)).history)).toContain(
    'PRIVATE_MEMORY_CANARY',
  )
})
test('deleting or revoking consent fences a run that already read the memory and removes its vectors', async () => {
  const m = await addMemory(deps, alice, { content: '公开偏好', allowSite: true })
  await indexMemory(m.id)
  const r = await ask('偏好'),
    lease = await claim(r.id)
  await executeAgentTool(deps, lease, 'recall_memories', { query: '偏好' })
  await setMemoryPrivacy(deps, alice, m.id, { allowSite: false, expectedContentVersion: 1 })
  expect((await getAgentRun(deps, alice, r.id)).run.status).toBe('cancelled')
  expect(await deps.db.select().from(memoryEmbeddings)).toEqual([])
  await expect(
    executeAgentTool(deps, lease, 'recall_memories', { query: '偏好' }),
  ).rejects.toMatchObject({ code: 'CONFLICT' })
})
test('editing or recalling a message makes a late embedding write a no-op and immediately removes old vectors', async () => {
  const g = (
    await createConversation(
      deps,
      alice,
      { kind: 'group', name: '版本', memberIds: [bob.userId] },
      crypto.randomUUID(),
    )
  ).conversation
  const original = (
    await sendMessage(deps, alice, g.id, { clientId: deps.newId(), body: '部署安排原文' })
  ).envelope.message
  expect(
    await indexEmbedding(deps, {
      id: original.id,
      version: 1,
      modelVersion: model.version,
      target: 'message',
    }),
  ).toBe(true)
  const edited = (
    await editMessage(deps, alice, original.id, {
      body: '已经取消发布',
      expectedChangeSeq: original.changeSeq,
    })
  ).message
  expect(await deps.db.select().from(messageEmbeddings)).toEqual([])
  expect(
    await indexEmbedding(deps, {
      id: original.id,
      version: 1,
      modelVersion: model.version,
      target: 'message',
    }),
  ).toBe(false)
  expect(
    await indexEmbedding(deps, {
      id: original.id,
      version: 2,
      modelVersion: model.version,
      target: 'message',
    }),
  ).toBe(true)
  await recallMessage(deps, alice, edited.id)
  expect(
    await indexEmbedding(deps, {
      id: original.id,
      version: 2,
      modelVersion: model.version,
      target: 'message',
    }),
  ).toBe(false)
  expect(await deps.db.select().from(messageEmbeddings)).toEqual([])
})
test('content changed during native inference cannot be published', async () => {
  const m = await addMemory(deps, alice, { content: '等待推理结果', allowSite: true })
  deps.embeddings = {
    modelVersion: model.version,
    dimension: 512,
    embed: async () => {
      await deleteMemory(deps, alice, m.id)
      return vector()
    },
  }
  expect(await indexMemory(m.id)).toBe(false)
  expect(await deps.db.select().from(memoryEmbeddings)).toEqual([])
})
test('hybrid retrieval filters hidden, recalled, old versions, outside scope and private content before returning it', async () => {
  const g = (
    await createConversation(
      deps,
      alice,
      { kind: 'group', name: '语义', memberIds: [bob.userId] },
      crypto.randomUUID(),
    )
  ).conversation
  const msg = (
    await sendMessage(deps, alice, g.id, { clientId: deps.newId(), body: '由林舟负责部署' })
  ).envelope.message
  await indexEmbedding(deps, {
    id: msg.id,
    version: 1,
    modelVersion: model.version,
    target: 'message',
  })
  const r = await ask('找上线负责人'),
    lease = await claim(r.id)
  expect(
    JSON.stringify(
      await executeAgentTool(deps, lease, 'semantic_search_messages', {
        query: '上线负责人',
        conversationIds: [g.id],
      }),
    ),
  ).toContain('由林舟负责部署')
  await deps.db
    .update(messages)
    .set({ privacyClass: 'byok_private' })
    .where(eq(messages.id, msg.id))
  // The already-read source invalidates this run, so a new request must rebuild its context.
  await expect(
    executeAgentTool(deps, lease, 'semantic_search_messages', {
      query: '上线负责人',
      conversationIds: [g.id],
    }),
  ).rejects.toMatchObject({ code: 'CONTEXT_CHANGED' })
})
test('a durable model backfill advances its cursor, deduplicates jobs and preserves dimension-separated generations', async () => {
  const g = (
    await createConversation(
      deps,
      alice,
      { kind: 'group', name: '回填', memberIds: [bob.userId] },
      crypto.randomUUID(),
    )
  ).conversation
  for (let i = 0; i < 3; i++)
    await sendMessage(deps, alice, g.id, { clientId: deps.newId(), body: `消息内容${i}` })
  expect(await backfillEmbeddings(deps, model.version, 2)).toBe(2)
  expect(await backfillEmbeddings(deps, model.version, 2)).toBe(1)
  expect(await backfillEmbeddings(deps, model.version, 2)).toBe(0)
  const work = await deps.db.select().from(workItems).where(eq(workItems.kind, 'embedding'))
  expect(work).toHaveLength(3)
  await deps.db.insert(embeddingModels).values({
    version: EMBEDDING_MODELS.qwen.version,
    dimension: 1024,
    status: 'staging',
    createdAt: deps.clock.now(),
  })
  expect(await backfillEmbeddings(deps, EMBEDDING_MODELS.qwen.version, 100)).toBe(3)
  expect(
    await deps.db.select().from(workItems).where(eq(workItems.kind, 'embedding')),
  ).toHaveLength(6)
})
test('rolling private summaries are source-checked, expire without renewal and never enter a site segment', async () => {
  await saveAiKey(deps, alice, { provider: 'deepseek', key: 'sk-mock-summary-private-7f3a' })
  const r = await ask('开始'),
    lease = await claim(r.id)
  const [context] = await deps.db
    .select()
    .from(agentContexts)
    .where(eq(agentContexts.conversationId, r.conversationId ?? ''))
  if (!context || !r.conversationId) throw new Error('missing private conversation')
  const [prompt] = await deps.db
    .select()
    .from(messages)
    .where(eq(messages.id, r.sourceMessageId ?? ''))
  if (!prompt) throw new Error('missing prompt')
  const expiresAt = new Date(deps.clock.now().getTime() + 60000)
  await deps.db.insert(agentConversationState).values({
    conversationId: r.conversationId,
    contextEpoch: context.contextEpoch,
    keySource: 'user',
    privacyClass: 'byok_private',
    sourceManifest: [],
    summary: 'PRIVATE_SUMMARY_CANARY',
    summarizedThroughSeq: 0,
    expiresAt,
    updatedAt: deps.clock.now(),
  })
  expect(JSON.stringify((await buildAgentContext(deps, lease)).history)).toContain(
    'PRIVATE_SUMMARY_CANARY',
  )
  expect((await deps.db.select().from(agentConversationState))[0]?.expiresAt).toEqual(expiresAt)
  await completeAgentRun(deps, lease)
  await switchAgentKeySource(deps, alice, r.conversationId, 'site')
  const site = await ask('新的空白段', r.conversationId),
    siteLease = await claim(site.id)
  expect(JSON.stringify((await buildAgentContext(deps, siteLease)).history)).not.toContain(
    'PRIVATE_SUMMARY_CANARY',
  )
})
