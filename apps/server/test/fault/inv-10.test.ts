/**
 * INV-10 / AT-07 crash injection with real processes (docs/08 section 4): an approved effect of the assistant happens
 * exactly once when the worker is killed (SIGKILL, no shutdown) right after the step and decision became durable but
 * before the effect, and right after the effect committed but before it was reported. A new worker recovers the run
 * from Postgres alone. Always inside the isolated instance of the run (D-085, AT-34).
 *
 * Run through `bun run test:fault`, which creates the instance and passes its manifest in CHATAPP_FAULT_MANIFEST.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { agentEffects, agentRuns, messages } from '@chatapp/db'
import { and, eq } from 'drizzle-orm'
import { recoverAgentRuns } from '../../src/domain/agent-runs.ts'
import { createActiveUser, makeDeps } from '../support/deps.ts'
import {
  ApiClient,
  type ApiService,
  type FaultInstance,
  openFaultInstance,
  type Service,
  startApi,
  startWorker,
  waitUntil,
} from '../support/fault/instance.ts'

let instance: FaultInstance
const started: Service[] = []

beforeAll(async () => {
  instance = await openFaultInstance()
})
afterAll(async () => {
  await instance.close()
})
beforeEach(async () => {
  await instance.reset()
})
afterEach(async () => {
  for (const service of started.splice(0)) await service.stop()
})

const db = () => instance.databases.owner.db

async function api(): Promise<ApiService> {
  const service = await startApi(instance)
  started.push(service)
  return service
}
async function worker(extra: Record<string, string> = {}): Promise<Service> {
  const service = await startWorker(instance, extra)
  started.push(service)
  return service
}

type Run = { id: string; status: string; conversationId: string | null }
type Approval = { id: string; stateVersion: number; status: string }

/** Alice asks her panel to send into a group she shares with Bob, and approves; returns the run and the group. */
async function approvedSend(service: ApiService) {
  const deps = makeDeps(db())
  const alice = await createActiveUser(deps, { username: 'alice' })
  const bob = await createActiveUser(deps, { username: 'bob' })
  const client = new ApiClient(service.baseUrl)
  await client.signIn(alice.email, alice.password)
  const me = await client.call<{ timezone: string }>('/api/me')
  const group = await client.call<{ id: string }>('/api/conversations', {
    json: { kind: 'group', name: 'exactly once', memberIds: [bob.id] },
    headers: { 'idempotency-key': crypto.randomUUID() },
  })
  expect(group.status).toBe(201)
  const created = await client.call<{ run: Run }>('/api/agent/runs', {
    json: {
      trigger: 'panel',
      contextConversationId: group.body.id,
      prompt: '代发：只发一次',
      timezone: me.body.timezone,
    },
    headers: { 'idempotency-key': crypto.randomUUID() },
  })
  expect(created.status).toBe(200)
  const runId = created.body.run.id
  const approval = await waitUntil(
    async () => {
      const detail = await client.call<{ run: Run; approvals: Approval[] }>(
        `/api/agent/runs/${runId}`,
      )
      return detail.body.run.status === 'awaiting_approval' ? detail.body.approvals[0] : undefined
    },
    { guardMs: 30_000, what: 'the run to wait for approval' },
  )
  const decided = await client.call(`/api/agent/approvals/${approval.id}`, {
    json: { decision: 'approve', expectedStateVersion: approval.stateVersion },
  })
  expect(decided.status).toBe(200)
  return { runId, groupId: group.body.id, aliceId: alice.id, client }
}

const sentBy = async (groupId: string, userId: string) =>
  await db()
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, groupId), eq(messages.senderId, userId)))

/** The killed worker's lease would expire after 30 s; recovery reads only Postgres, here with the clock moved on. */
async function recoverAfterLease(): Promise<void> {
  const deps = makeDeps(db())
  deps.clock.advance(31_000)
  await recoverAgentRuns(deps)
}

describe('an approved effect survives a worker killed around it (INV-10)', () => {
  for (const point of ['effect.before', 'effect.after'] as const) {
    test(`killed at ${point}: one message, one ledger row, and the run completes`, async () => {
      const service = await api()
      const paused = await worker({ CHATAPP_FAULT_PAUSE: point })
      const { runId, groupId, aliceId } = await approvedSend(service)
      await waitUntil(() => paused.logTail().includes(`fault-point reached: ${point}`), {
        guardMs: 30_000,
        what: `the worker to reach ${point}`,
      })
      paused.signal('SIGKILL')
      await paused.exited
      const committed = await sentBy(groupId, aliceId)
      expect(committed).toHaveLength(point === 'effect.before' ? 0 : 1)

      await recoverAfterLease()
      await worker()
      const [done] = await waitUntil(
        async () => {
          const rows = await db().select().from(agentRuns).where(eq(agentRuns.id, runId))
          return rows[0]?.status === 'completed' ? rows : undefined
        },
        { guardMs: 40_000, what: 'the recovered run to complete' },
      )
      expect(done?.hasEffects).toBe(true)
      const sent = await sentBy(groupId, aliceId)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ body: '只发一次', executionSource: 'agent_effect' })
      expect(
        await db().select().from(agentEffects).where(eq(agentEffects.runId, runId)),
      ).toHaveLength(1)
    }, 120_000)
  }
})
