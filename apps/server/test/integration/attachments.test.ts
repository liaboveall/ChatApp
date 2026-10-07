import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { AttachmentPage, MessageEnvelope, Upload } from '@chatapp/contracts'
import {
  attachmentObjects,
  attachments,
  messageMentions,
  siteStorage,
  uploadReservations,
  users,
  workItems,
} from '@chatapp/db'
import { eq, sql } from 'drizzle-orm'
import {
  cleanupAttachments,
  processAttachment,
  reconcileStorage,
} from '../../src/domain/attachment-processing.ts'
import { claimReadyWork, recoverExpiredWork } from '../../src/domain/work-queue.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createTestApp, type TestApp } from '../support/http.ts'
import { createConversation, key, type Person, person } from '../support/people.ts'
import { connect, cookieHeader, deliverHints, startTestServer } from '../support/ws.ts'

let dbs: TestDatabases, app: TestApp
beforeAll(() => {
  dbs = openTestDatabases()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
  app = await createTestApp(dbs)
})
afterEach(async () => {
  const objects = await dbs.owner.db.select().from(attachmentObjects)
  for (const object of objects) await app.services.deps.blobs?.delete(object.storageKey)
  await app.close()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
async function reserve(who: Person, name = 'pwn.html', size = 100, extra = {}) {
  const reply = await who.post<Upload>(
    '/api/uploads/reservations',
    { purpose: 'message', name, declaredSize: size, ...extra },
    key(),
  )
  expect(reply.status).toBe(200)
  return reply.body
}
async function put(who: Person, upload: Upload, text = '<script>location="stolen"</script>') {
  return app.request(`/api/uploads/${upload.uploadId}/content`, {
    method: 'PUT',
    jar: who.jar,
    body: new TextEncoder().encode(text),
    headers: { 'content-type': 'application/octet-stream' },
  })
}
async function processNext() {
  const [work] = await claimReadyWork(app.services.deps, { limit: 1, kinds: ['media'] })
  expect(work).toBeDefined()
  if (!work) throw new Error('work missing')
  expect(
    await processAttachment(app.services.deps, { id: work.id, leaseEpoch: work.leaseEpoch }),
  ).toBe('ready')
}
async function ready(who: Person, text = '<script>location="stolen"</script>', extra = {}) {
  const upload = await reserve(who, 'pwn.html', new TextEncoder().encode(text).length, extra)
  expect((await put(who, upload, text)).status).toBe(200)
  await processNext()
  const reply = await who.get<Upload>(`/api/uploads/${upload.uploadId}`)
  expect(reply.body.status).toBe('ready')
  if (!reply.body.attachment) throw new Error('attachment missing')
  return { ...reply.body, attachment: reply.body.attachment }
}
async function bytes(who: Person, path: string, headers?: Record<string, string>) {
  return app.request(path, { jar: who.jar, headers })
}

test('L-12: HTML and SVG disguised as PNG stay download-only, no-store, nosniff and sandbox', async () => {
  const alice = await person(app, 'alice')
  for (const text of ['<script>alert(1)</script>', '<svg onload="alert(1)"></svg>']) {
    const upload = await reserve(alice, 'avatar.png', text.length)
    expect((await put(alice, upload, text)).status).toBe(200)
    await processNext()
    const result = (await alice.get<Upload>(`/api/uploads/${upload.uploadId}`)).body
    expect(result.attachment?.kind).toBe('file')
    const response = await bytes(alice, result.attachment?.urls.original ?? '')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toStartWith('attachment;')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.text()).toBe(text)
  }
})
test('download filenames remain encodable after Unicode normalization and truncation', async () => {
  const alice = await person(app, 'alice')
  // NFC doubles U+0344; the 255-code-unit bound then cuts the final astral character.
  const file = await ready(alice, 'unicode', { name: `${'\u0344'.repeat(127)}😀` })
  const response = await bytes(alice, file.attachment.urls.original)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''")
  expect(await response.text()).toBe('unicode')
})
test('reservation replay is stable; changed request conflicts and concurrent quota admits exactly one', async () => {
  const alice = await person(app, 'alice')
  await dbs.owner.db
    .update(users)
    .set({ storageQuotaBytes: 20 * 1024 * 1024 })
    .where(eq(users.id, alice.id))
  const request = { purpose: 'message', name: 'one', declaredSize: 3 },
    headers = key()
  const outcomes = await Promise.all([
    alice.post<Upload>('/api/uploads/reservations', request, headers),
    alice.post<Upload>('/api/uploads/reservations', request, key()),
  ])
  expect(outcomes.map((r) => r.status).sort()).toEqual([200, 403])
  const first = outcomes[0]
  if (first?.status === 200) {
    expect(
      (await alice.post<Upload>('/api/uploads/reservations', request, headers)).body.uploadId,
    ).toBe(first.body.uploadId)
    expect(
      (await alice.post('/api/uploads/reservations', { ...request, name: 'different' }, headers))
        .status,
    ).toBe(409)
  }
  const [user] = await dbs.owner.db.select().from(users).where(eq(users.id, alice.id))
  expect(user?.storageReservedBytes).toBe(20 * 1024 * 1024)
})
test('stream oversize rejects unknown Content-Length and cancelled reservation cannot be replayed', async () => {
  const alice = await person(app, 'alice'),
    upload = await reserve(alice, 'small.txt', 2)
  expect((await put(alice, upload, 'three')).status).toBe(413)
  expect((await put(alice, upload, 'ok')).status).toBe(409)
  const [user] = await dbs.owner.db.select().from(users).where(eq(users.id, alice.id))
  expect(user?.storageReservedBytes).toBe(0)
  const [site] = await dbs.owner.db.select().from(siteStorage)
  expect(site?.reservedBytes).toBeGreaterThan(0) // uncertain physical write still charged until confirmed deleted
  app.clock.advance(5 * 60_000)
  await cleanupAttachments(app.services.deps)
  expect((await dbs.owner.db.select().from(siteStorage))[0]?.reservedBytes).toBe(0)
})
test('authenticated stream framing and MIME checks happen before upload parsing', async () => {
  const alice = await person(app, 'alice'),
    upload = await reserve(alice)
  for (const [headers, status] of [
    [{ 'content-type': 'image/png' }, 415],
    [{ 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' }, 415],
    [
      {
        'content-type': 'application/octet-stream',
        'content-length': '10',
        'transfer-encoding': 'chunked',
      },
      400,
    ],
  ] as const)
    expect(
      (
        await app.request(`/api/uploads/${upload.uploadId}/content`, {
          method: 'PUT',
          jar: alice.jar,
          headers,
          body: new Uint8Array([1]),
        })
      ).status,
    ).toBe(status)
})
test('attachments bind once; private download and every conditional Range use current membership and history', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bobby'),
    outsider = await person(app, 'outsider')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'private',
    memberIds: [bob.id],
  })
  const upload = await ready(alice, '0123456789', { conversationId: group.id })
  expect((await bytes(bob, upload.attachment.urls.original)).status).toBe(404)
  const request = { clientId: crypto.randomUUID(), attachmentIds: [upload.attachment.id] }
  const sent = await alice.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, request)
  expect(sent.status).toBe(201)
  expect(sent.body.message.attachments).toHaveLength(1)
  expect(
    (await alice.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, request)).body
      .message.id,
  ).toBe(sent.body.message.id)
  expect(
    (
      await alice.post(`/api/conversations/${group.id}/messages`, {
        ...request,
        clientId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(422)
  const partial = await bytes(bob, upload.attachment.urls.original, { Range: 'bytes=2-5' })
  expect(partial.status).toBe(206)
  expect(await partial.text()).toBe('2345')
  expect(partial.headers.get('content-range')).toBe('bytes 2-5/10')
  const suffix = await bytes(bob, upload.attachment.urls.original, { Range: 'bytes=-2' })
  expect(suffix.status).toBe(206)
  expect(await suffix.text()).toBe('89')
  expect((await bytes(bob, upload.attachment.urls.original, { Range: 'bytes=100-' })).status).toBe(
    416,
  )
  const etag = partial.headers.get('etag') ?? ''
  expect(
    (await bytes(outsider, upload.attachment.urls.original, { 'If-None-Match': etag })).status,
  ).toBe(404)
  await bob.post(`/api/conversations/${group.id}/leave`)
  expect(
    (await bytes(bob, upload.attachment.urls.original, { Range: 'bytes=0-', 'If-Range': etag }))
      .status,
  ).toBe(404)
  expect(
    (await alice.post(`/api/conversations/${group.id}/members`, { userIds: [bob.id] }, key()))
      .status,
  ).toBe(200)
  expect((await bytes(bob, upload.attachment.urls.original)).status).toBe(404)
  const files = await bob.get<AttachmentPage>(`/api/conversations/${group.id}/attachments`)
  expect(files.body.items).toHaveLength(0)
})
test('hidden and recalled messages disappear from shared files; refund and physical deletion each happen once', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bobby')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'private',
    memberIds: [bob.id],
  })
  const upload = await ready(alice, 'a file', { conversationId: group.id })
  const sent = await alice.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, {
    clientId: crypto.randomUUID(),
    attachmentIds: [upload.attachment.id],
  })
  const messageId = sent.body.message.id
  expect(
    (await bob.get<AttachmentPage>(`/api/conversations/${group.id}/attachments`)).body.items,
  ).toHaveLength(1)
  expect((await bob.post(`/api/messages/${messageId}/hide`)).status).toBe(200)
  expect(
    (await bob.get<AttachmentPage>(`/api/conversations/${group.id}/attachments`)).body.items,
  ).toHaveLength(0)
  expect((await bytes(bob, upload.attachment.urls.original)).status).toBe(404)
  expect((await alice.post(`/api/messages/${messageId}/recall`)).status).toBe(200)
  expect((await alice.post(`/api/messages/${messageId}/recall`)).status).toBe(200)
  expect((await bytes(alice, upload.attachment.urls.original)).status).toBe(404)
  expect(
    (await dbs.owner.db.select().from(users).where(eq(users.id, alice.id)))[0]?.storageUsedBytes,
  ).toBe(0)
  app.clock.advance(5 * 60_000)
  await cleanupAttachments(app.services.deps)
  await cleanupAttachments(app.services.deps)
  expect((await dbs.owner.db.select().from(siteStorage))[0]?.usedBytes).toBe(0)
  expect(
    (await dbs.owner.db.select().from(attachmentObjects)).every((o) => o.status === 'deleted'),
  ).toBe(true)
})
test('processing reservation outlives original receive expiry; lost work lease recovers from Postgres', async () => {
  const alice = await person(app, 'alice'),
    upload = await reserve(alice)
  expect((await put(alice, upload)).status).toBe(200)
  const [work] = await claimReadyWork(app.services.deps, { limit: 1, kinds: ['media'] })
  expect(work).toBeDefined()
  app.clock.advance(16 * 60_000)
  await recoverExpiredWork(app.services.deps)
  await cleanupAttachments(app.services.deps)
  expect((await alice.get<Upload>(`/api/uploads/${upload.uploadId}`)).body.status).toBe(
    'processing',
  )
  app.clock.advance(60_000)
  await processNext()
  const stale = work
    ? await processAttachment(app.services.deps, { id: work.id, leaseEpoch: work.leaseEpoch })
    : ''
  expect(stale).toBe('stale')
})
test('24-hour orphan cleanup excludes bound messages and retained avatars', async () => {
  const alice = await person(app, 'alice'),
    upload = await ready(alice)
  app.clock.advance(25 * 60 * 60_000)
  await cleanupAttachments(app.services.deps)
  expect((await bytes(alice, upload.attachment.urls.original)).status).toBe(404)
  expect(
    (await dbs.owner.db.select().from(users).where(eq(users.id, alice.id)))[0]?.storageUsedBytes,
  ).toBe(0)
})
test('mentions use current names, deduplicate, edits replace recipients without notification work, recall removes rows', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bobby')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'private',
    memberIds: [bob.id],
  })
  const sent = await alice.post<MessageEnvelope>(`/api/conversations/${group.id}/messages`, {
    clientId: crypto.randomUUID(),
    body: `<@user:${bob.id}> <@user:${bob.id}>`,
  })
  expect(sent.body.message.mentions).toEqual([bob.id])
  expect(sent.body.users[bob.id]?.displayName).toBe('bobby')
  const edited = await alice.patch<MessageEnvelope>(`/api/messages/${sent.body.message.id}`, {
    body: `<@user:${alice.id}>`,
    expectedChangeSeq: sent.body.message.changeSeq,
  })
  expect(edited.status).toBe(200)
  expect(edited.body.message.mentions).toEqual([alice.id])
  expect((await dbs.owner.db.select().from(workItems)).every((w) => w.kind === 'realtime')).toBe(
    true,
  )
  await alice.post(`/api/messages/${sent.body.message.id}/recall`)
  expect(await dbs.owner.db.select().from(messageMentions)).toHaveLength(0)
})
test('site pressure rejects atomically without changing user reservations', async () => {
  const alice = await person(app, 'alice')
  await dbs.owner.db.insert(siteStorage).values({ id: 1, budgetBytes: 10 })
  expect(
    (
      await alice.post(
        '/api/uploads/reservations',
        { purpose: 'message', name: 'file', declaredSize: 5 },
        key(),
      )
    ).status,
  ).toBe(503)
  expect(await dbs.owner.db.select().from(uploadReservations)).toHaveLength(0)
  expect(await dbs.owner.db.select().from(attachments)).toHaveLength(0)
  expect(
    (await dbs.owner.db.select().from(users).where(eq(users.id, alice.id)))[0]
      ?.storageReservedBytes,
  ).toBe(0)
})
test('deferred ledger constraint refuses publishing unvalidated objects', async () => {
  const alice = await person(app, 'alice')
  const upload = await reserve(alice)
  const [r] = await dbs.owner.db
    .select()
    .from(uploadReservations)
    .where(eq(uploadReservations.id, upload.uploadId))
  await expect(
    Promise.resolve(
      dbs.owner.db.execute(
        sql`update attachments set status = 'ready', storage_key = 'missing', sha256 = repeat('a',64), size_bytes = 1, charged_bytes = 1 where id = ${r?.attachmentId}`,
      ),
    ),
  ).rejects.toThrow()
})

test('an independent scan repairs durable counters and blocks unknown/missing objects without deleting evidence', async () => {
  const alice = await person(app, 'alice'),
    file = await ready(alice, 'ledger')
  const store = app.services.deps.blobs
  if (!store) throw new Error('store missing')
  await dbs.owner.db
    .update(users)
    .set({ storageUsedBytes: 0, storageReservedBytes: 1 })
    .where(eq(users.id, alice.id))
  await dbs.owner.db
    .update(siteStorage)
    .set({ usedBytes: 0, reservedBytes: 1 })
    .where(eq(siteStorage.id, 1))
  const unknown = `att/unknown-${crypto.randomUUID()}`
  const scoped = {
    ...app.services.deps,
    blobs: {
      ...store,
      list: async (cursor?: string) => {
        const page = await store.list(cursor)
        return {
          ...page,
          items: page.items.filter(
            (item) => item.key.startsWith(`att/${file.attachment.id}/`) || item.key === unknown,
          ),
        }
      },
    },
  }
  expect((await reconcileStorage(scoped)).blocked).toBe(false)
  await store.put(unknown, new Blob(['unknown']).stream())
  try {
    expect((await reconcileStorage(scoped)).blocked).toBe(true)
    expect((await store.stat(unknown))?.size).toBe(7)
    const [user] = await dbs.owner.db.select().from(users).where(eq(users.id, alice.id))
    expect(user?.storageUsedBytes).toBe(6)
    expect(user?.storageReservedBytes).toBe(0)
    expect(
      (
        await alice.post(
          '/api/uploads/reservations',
          { purpose: 'message', name: 'blocked', declaredSize: 1 },
          key(),
        )
      ).status,
    ).toBe(503)
  } finally {
    await store.delete(unknown)
  }
  // Isolate the missing-live-object check from other tests' deliberate test-bucket leftovers.
  const [object] = await dbs.owner.db
    .select()
    .from(attachmentObjects)
    .where(
      sql`${attachmentObjects.attachmentId} = ${file.attachment.id} and ${attachmentObjects.status} = 'live' and ${attachmentObjects.variant} = 'original'`,
    )
  if (!object) throw new Error('ledger missing')
  await store.delete(object.storageKey)
  expect((await reconcileStorage(scoped)).blocked).toBe(true)
})
test('DB refuses a live-object mutation leaving a ready attachment without a valid ledger', async () => {
  const alice = await person(app, 'alice'),
    file = await ready(alice, 'immutable')
  await expect(
    Promise.resolve(
      dbs.owner.db
        .update(attachmentObjects)
        .set({ status: 'deleting' })
        .where(eq(attachmentObjects.attachmentId, file.attachment.id)),
    ),
  ).rejects.toBeDefined()
  await expect(
    Promise.resolve(
      dbs.owner.db
        .update(attachmentObjects)
        .set({ storageKey: 'att/changed' })
        .where(eq(attachmentObjects.attachmentId, file.attachment.id)),
    ),
  ).rejects.toBeDefined()
  expect((await bytes(alice, file.attachment.urls.original)).status).toBe(200)
})
test('mention candidates find current members, include self and exclude outsiders', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bobby'),
    outsider = await person(app, 'outside')
  const c = await createConversation(alice, {
    kind: 'group',
    name: 'mentions',
    memberIds: [bob.id],
  })
  const result = await alice.get<{ users: { id: string }[] }>(
    `/api/conversations/${c.id}/mentions?query=bobb`,
  )
  expect(result.status).toBe(200)
  expect(result.body.users.map((u) => u.id)).toEqual([bob.id])
  const self = await alice.get<{ users: { id: string }[] }>(
    `/api/conversations/${c.id}/mentions?query=alice`,
  )
  expect(self.body.users.map((u) => u.id)).toContain(alice.id)
  expect((await outsider.get(`/api/conversations/${c.id}/mentions`)).status).toBe(404)
})

test('attachment.updated is durable, contains only identifiers and versions, and reaches only the uploader', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bobby')
  const server = await startTestServer(app)
  const a = connect(server.port, { cookie: cookieHeader(alice.jar) }),
    b = connect(server.port, { cookie: cookieHeader(bob.jar) })
  try {
    await Promise.all([a.next('hello'), b.next('hello')])
    const file = await ready(alice, 'private filename')
    await deliverHints(app, server)
    const event = await a.next('attachment.updated')
    expect(event.data).toEqual({
      attachmentId: file.attachment.id,
      generation: file.attachment.generation,
      version: file.attachment.version,
    })
    await Bun.sleep(150)
    expect(b.of('attachment.updated')).toHaveLength(0)
    expect(JSON.stringify(event)).not.toContain('private filename')
  } finally {
    a.ws.close()
    b.ws.close()
    await server.stop()
  }
})
test('membership revoked during the content stream prevents processing publication and refunds quota', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bobby')
  const c = await createConversation(alice, {
    kind: 'group',
    name: 'receiving',
    memberIds: [bob.id],
  })
  const reservation = await reserve(bob, 'stream', 4, { conversationId: c.id })
  let allow: () => void = () => undefined,
    seen: () => void = () => undefined,
    pulls = 0
  const gate = new Promise<void>((resolve) => {
      allow = resolve
    }),
    waiting = new Promise<void>((resolve) => {
      seen = resolve
    })
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(new Uint8Array([1, 2]))
          return
        }
        seen()
        await gate
        controller.enqueue(new Uint8Array([3, 4]))
        controller.close()
      },
    },
    { highWaterMark: 0 },
  )
  const receiving = app.request(`/api/uploads/${reservation.uploadId}/content`, {
    method: 'PUT',
    jar: bob.jar,
    body: stream,
    headers: { 'content-type': 'application/octet-stream' },
  })
  await waiting
  expect((await alice.del(`/api/conversations/${c.id}/members/${bob.id}`)).status).toBe(200)
  allow()
  expect((await receiving).status).toBe(404)
  const [user] = await dbs.owner.db.select().from(users).where(eq(users.id, bob.id))
  expect(user?.storageReservedBytes).toBe(0)
  expect(
    await dbs.owner.db.select().from(workItems).where(eq(workItems.kind, 'media')),
  ).toHaveLength(0)
})

test('a same-size corrupted input cannot be published with a false digest and its quota is refunded', async () => {
  const alice = await person(app, 'alice'),
    upload = await reserve(alice, 'digest.txt', 4)
  expect((await put(alice, upload, 'good')).status).toBe(200)
  const [input] = await dbs.owner.db
    .select()
    .from(attachmentObjects)
    .where(eq(attachmentObjects.variant, 'input'))
  const store = app.services.deps.blobs
  if (!input || !store) throw new Error('input missing')
  await store.put(input.storageKey, new Blob(['evil']).stream())
  const [work] = await claimReadyWork(app.services.deps, { limit: 1, kinds: ['media'] })
  if (!work) throw new Error('work missing')
  expect(
    await processAttachment(app.services.deps, { id: work.id, leaseEpoch: work.leaseEpoch }),
  ).toBe('failed')
  expect((await alice.get<Upload>(`/api/uploads/${upload.uploadId}`)).body.status).toBe('failed')
  const [user] = await dbs.owner.db.select().from(users).where(eq(users.id, alice.id))
  expect(user?.storageUsedBytes).toBe(0)
  expect(user?.storageReservedBytes).toBe(0)
})

test('a completed content replay returns current state; different bytes cannot overwrite or cancel the accepted file', async () => {
  const alice = await person(app, 'alice'),
    file = await ready(alice, 'original')
  const before = (await alice.get<Upload>(`/api/uploads/${file.uploadId}`)).body
  expect((await put(alice, before, 'original')).status).toBe(200)
  expect((await put(alice, before, 'changed!')).status).toBe(409)
  expect(await (await bytes(alice, file.attachment.urls.original)).text()).toBe('original')
  const after = (await alice.get<Upload>(`/api/uploads/${file.uploadId}`)).body
  expect(after.status).toBe('ready')
  expect(after.attachment?.version).toBe(before.attachment?.version)
  const [user] = await dbs.owner.db.select().from(users).where(eq(users.id, alice.id))
  expect(user?.storageUsedBytes).toBe(8)
  expect(user?.storageReservedBytes).toBe(0)
})

test('native media reads deny a stale cookie without changing cookies; ordinary API probes still clear it', async () => {
  const alice = await person(app, 'alice'),
    file = await ready(alice, 'native media')
  const stale = new Map(alice.jar)
  expect((await alice.post('/api/me/devices/revoke-all')).status).toBe(200)
  const response = await app.request(file.attachment.urls.original, { jar: new Map(stale) })
  expect(response.status).toBe(401)
  expect(response.headers.getSetCookie()).toHaveLength(0)
  const probe = await app.request('/api/me', { jar: stale })
  expect(probe.status).toBe(401)
  expect(probe.headers.getSetCookie().length).toBeGreaterThan(0)
})

test('R1: mention excerpts resolve before truncation, rename with the profile, and pure attachments are worded', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bobby')
  const group = await createConversation(alice, {
    kind: 'group',
    name: 'R1 plain outlets',
    memberIds: [bob.id],
  })
  const original = await alice.post<MessageEnvelope>(
    `/api/conversations/${group.id}/messages`,
    { body: `hi <@user:${bob.id}> see this`, clientId: crypto.randomUUID() },
    key(),
  )
  expect(original.status).toBe(201)
  const preview = await bob.get<{
    conversations: Array<{ id: string; lastMessagePreview: { text: string } }>
  }>('/api/conversations')
  expect(
    preview.body.conversations.find((item) => item.id === group.id)?.lastMessagePreview.text,
  ).toBe('hi @bobby see this')
  await dbs.owner.db.update(users).set({ name: 'New name' }).where(eq(users.id, bob.id))
  const reply = await bob.post<MessageEnvelope>(
    `/api/conversations/${group.id}/messages`,
    { body: 'reply', replyToId: original.body.message.id, clientId: crypto.randomUUID() },
    key(),
  )
  expect(reply.status).toBe(201)
  expect(reply.body.message.replyTo).toMatchObject({ excerpt: 'hi @New name see this' })
  const file = await ready(alice, 'file contents', { conversationId: group.id })
  const attached = await alice.post<MessageEnvelope>(
    `/api/conversations/${group.id}/messages`,
    { attachmentIds: [file.attachment.id], clientId: crypto.randomUUID() },
    key(),
  )
  expect(attached.status).toBe(201)
  const after = await bob.get<{
    conversations: Array<{ id: string; lastMessagePreview: { text: string } }>
  }>('/api/conversations')
  expect(
    after.body.conversations.find((item) => item.id === group.id)?.lastMessagePreview.text,
  ).toBe('[file]')
  const quoted = await bob.post<MessageEnvelope>(
    `/api/conversations/${group.id}/messages`,
    { body: 'file reply', replyToId: attached.body.message.id, clientId: crypto.randomUUID() },
    key(),
  )
  expect(quoted.body.message.replyTo).toMatchObject({ excerpt: '[file]', attachmentKind: 'file' })
})

test('aborted multipart writes settle and remove their visible partial object', async () => {
  const store = app.services.deps.blobs
  if (!store) throw new Error('store missing')
  const key = `att/cancel-probe-${crypto.randomUUID()}`
  const controller = new AbortController()
  let chunks = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(output) {
        if (chunks === 3) {
          controller.abort()
          output.close()
          return
        }
        output.enqueue(new Uint8Array(chunks++ === 2 ? 1024 * 1024 : 5 * 1024 * 1024))
      },
    },
    { highWaterMark: 0 },
  )
  try {
    await expect(store.put(key, stream, controller.signal)).rejects.toThrow()
    expect(await store.stat(key)).toBeNull()
  } finally {
    await store.delete(key)
  }
})
test('download authorization matrix: private group, channel and DM attachments; a site administrator has no message privilege', async () => {
  const alice = await person(app, 'alice'),
    bob = await person(app, 'bobby'),
    stranger = await person(app, 'stranger'),
    admin = await person(app, 'siteadmin', { role: 'admin' })
  const dm = await alice.post<{ id: string }>('/api/conversations/dm', { userId: bob.id })
  expect([200, 201]).toContain(dm.status)
  for (const conversation of [
    await createConversation(alice, { kind: 'group', name: 'group', memberIds: [bob.id] }),
    await createConversation(alice, { kind: 'channel', name: 'channel', memberIds: [bob.id] }),
    dm.body,
  ]) {
    const file = await ready(alice, 'matrix-private-bytes', { conversationId: conversation.id })
    await alice.post<MessageEnvelope>(`/api/conversations/${conversation.id}/messages`, {
      attachmentIds: [file.attachment.id],
      clientId: crypto.randomUUID(),
    })
    expect((await bytes(alice, file.attachment.urls.original)).status).toBe(200)
    expect((await bytes(bob, file.attachment.urls.original)).status).toBe(200)
    expect((await app.request(file.attachment.urls.original)).status).toBe(401)
    for (const outsider of [stranger, admin]) {
      for (const headers of [{}, { range: 'bytes=0-3' }, { 'if-none-match': '*' }] as Record<
        string,
        string
      >[]) {
        const denied = await bytes(outsider, file.attachment.urls.original, headers)
        const missing = await bytes(
          outsider,
          '/api/attachments/10000000-0000-4000-8000-000000000099/original',
          headers,
        )
        expect(denied.status).toBe(404)
        const refusal = (await denied.json()) as {
          error: { code: string; message: string; requestId: string }
        }
        const absent = (await missing.json()) as typeof refusal
        expect({ ...refusal.error, requestId: null }).toEqual({ ...absent.error, requestId: null })
      }
    }
  }
})
