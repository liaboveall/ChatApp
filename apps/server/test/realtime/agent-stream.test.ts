import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { agentRuns, sessions, users } from '@chatapp/db'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { eq } from 'drizzle-orm'
import { loadAiConfig } from '../../src/config/ai.ts'
import { claimAgentRun, createAgentRun, ensureAgentOutput } from '../../src/domain/agent-runs.ts'
import { endSession, resolveSessionPrincipal, revokeAllDevices } from '../../src/domain/sessions.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser } from '../support/deps.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { connect, cookieHeader, startTestServer, type TestServer } from '../support/ws.ts'

let dbs: TestDatabases
let app: TestApp
let server: TestServer | undefined
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
  const { apiKey: _key, ...policy } = loadAiConfig({ APP_ENV: 'test' })
  app.services.deps.config.ai = policy
  const product = app.services.deps.config.product
  await runBootstrap(app.services.deps.db, { ...product, productName: product.name })
})
afterEach(async () => {
  await server?.stop()
  server = undefined
  await app.close()
})

test('real gateway checks every agent batch without waiting for a logout/revoke hint', async () => {
  const deps = app.services.deps
  const user = await createActiveUser(deps, { username: 'streamowner' })
  const other = await createActiveUser(deps, { username: 'streamother' })
  const login = async (account: typeof user) => {
    const jar = app.newJar()
    const response = await app.request('/api/auth/sign-in/email', {
      jar,
      json: { email: account.email, password: account.password },
    })
    expect(response.status).toBe(200)
    const [session] = await deps.db.select().from(sessions).where(eq(sessions.userId, account.id))
    if (!session) throw new Error('missing session')
    const principal = await resolveSessionPrincipal(deps, session)
    if (!principal) throw new Error('missing principal')
    return { jar, session, principal }
  }
  const owner = await login(user)
  const peer = await login(other)
  const [profile] = await deps.db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, user.id))
  if (!profile) throw new Error('missing user')
  const run = await createAgentRun(
    deps,
    owner.principal,
    {
      trigger: 'agent_chat',
      mode: 'fast',
      prompt: '私有的流式回答',
      timezone: profile.timezone,
      attachmentIds: [],
    },
    crypto.randomUUID(),
  )
  const claim = await claimAgentRun(deps, run.id)
  if (!claim || !run.conversationId) throw new Error('missing run')
  const output = await ensureAgentOutput(deps, claim.lease)
  server = await startTestServer(app)
  const first = connect(server.port, { cookie: cookieHeader(owner.jar) })
  const unrelated = connect(server.port, { cookie: cookieHeader(peer.jar) })
  await first.next('hello')
  await unrelated.next('hello')
  const publish = async (index: number) => {
    await server?.bus.publish({
      type: 'agent.delta',
      conversationId: run.conversationId ?? '',
      runId: run.id,
      resumeSeq: run.resumeSeq,
      leaseEpoch: claim.lease.epoch,
      messageId: output,
      index,
      streamRevision: 0,
      text: `私有片段${index}`,
    })
  }
  await publish(1)
  await first.next('agent.delta')
  expect(unrelated.of('agent.delta')).toHaveLength(0)
  await endSession(deps, owner.session)
  await publish(2)
  await Bun.sleep(150)
  expect(first.of('agent.delta')).toHaveLength(1)
  const [running] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, run.id))
  expect(running?.status).toBe('running')
  const fresh = await login(user)
  const second = connect(server.port, { cookie: cookieHeader(fresh.jar) })
  await second.next('hello')
  await publish(3)
  await second.next('agent.delta')
  await revokeAllDevices(deps, fresh.principal)
  await publish(4)
  await Bun.sleep(150)
  expect(second.of('agent.delta')).toHaveLength(1)
  expect(unrelated.of('agent.delta')).toHaveLength(0)
  first.ws.close()
  second.ws.close()
  unrelated.ws.close()
})
