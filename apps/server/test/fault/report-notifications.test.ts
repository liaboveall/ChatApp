/** Real API/worker SIGKILL probes, only on the label/marker-verified isolated fault instance. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { notifications, reports, workItems } from '@chatapp/db'
import { and, eq } from 'drizzle-orm'
import { recoverExpiredWork } from '../../src/domain/work-queue.ts'
import { createActiveUser, makeDeps } from '../support/deps.ts'
import {
  ApiClient,
  type FaultInstance,
  openFaultInstance,
  type Service,
  startApi,
  startWorker,
  waitUntil,
} from '../support/fault/instance.ts'

let instance: FaultInstance
const services: Service[] = []
beforeAll(async () => {
  instance = await openFaultInstance()
})
beforeEach(async () => {
  await instance.reset()
})
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
})
afterAll(async () => {
  await instance?.close()
})

for (const point of ['notification.before', 'notification.after'] as const) {
  test(`report notification survives SIGKILL at ${point} and restart with one notification per administrator`, async () => {
    const deps = makeDeps(instance.databases.owner.db)
    for (const username of ['reportadmin1', 'reportadmin2', 'reportadmin3'])
      await createActiveUser(deps, { username, role: 'admin' })
    const member = await createActiveUser(deps, { username: 'reporter' })
    const api = await startApi(instance)
    services.push(api)
    const client = new ApiClient(api.baseUrl)
    await client.signIn(member.email, member.password)
    const group = await client.call<{ id: string }>('/api/conversations', {
      json: { kind: 'group', name: 'Fault report', memberIds: [] },
      headers: { 'idempotency-key': crypto.randomUUID() },
    })
    const sent = await client.call<{ message: { id: string } }>(
      `/api/conversations/${group.body.id}/messages`,
      {
        json: { clientId: crypto.randomUUID(), body: 'Synthetic report source' },
      },
    )
    const key = crypto.randomUUID(),
      input = { messageId: sent.body.message.id, reason: 'spam' }
    const receipt = await client.call<{ reportId: string }>('/api/reports', {
      json: input,
      headers: { 'idempotency-key': key },
    })
    expect(receipt.status).toBe(200)
    expect(await deps.db.select().from(reports)).toHaveLength(1)
    expect(
      await deps.db.select().from(workItems).where(eq(workItems.kind, 'notification')),
    ).toHaveLength(3)
    const paused = await startWorker(instance, {
      CHATAPP_FAULT_PAUSE: point,
      DELETION_JOURNAL_ENABLED: 'false',
    })
    services.push(paused)
    await waitUntil(() => paused.logTail().includes(`fault-point reached: ${point}`), {
      guardMs: 20000,
      what: point,
    })
    paused.signal('SIGKILL')
    await paused.exited
    expect(
      await deps.db.select().from(notifications).where(eq(notifications.type, 'report_opened')),
    ).toHaveLength(point === 'notification.before' ? 0 : 1)
    expect(
      (await client.call('/api/reports', { json: input, headers: { 'idempotency-key': key } }))
        .body,
    ).toEqual(receipt.body)
    // Accelerate only this isolated instance's expired lease and backoff timestamps.
    await deps.db
      .update(workItems)
      .set({ leaseUntil: new Date(0) })
      .where(and(eq(workItems.kind, 'notification'), eq(workItems.status, 'leased')))
    await recoverExpiredWork(deps)
    await deps.db
      .update(workItems)
      .set({ availableAt: deps.clock.now() })
      .where(and(eq(workItems.kind, 'notification'), eq(workItems.status, 'retry')))
    const restarted = await startWorker(instance, { DELETION_JOURNAL_ENABLED: 'false' })
    services.push(restarted)
    await waitUntil(
      async () =>
        (await deps.db.select().from(notifications).where(eq(notifications.type, 'report_opened')))
          .length === 3,
      { guardMs: 20000, what: 'all administrator notifications after restart' },
    )
    const delivered = await deps.db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'report_opened'))
    expect(new Set(delivered.map((row) => row.userId)).size).toBe(3)
    expect(
      await deps.db
        .select()
        .from(workItems)
        .where(and(eq(workItems.kind, 'notification'), eq(workItems.status, 'done'))),
    ).toHaveLength(3)
  }, 45000)
}
