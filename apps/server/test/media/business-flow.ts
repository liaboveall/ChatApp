/** Executed in the freshly built worker container, against that run's real API, queue, database, Garage and decoder. */

import { UPLOAD_LIMITS, type Upload, uploadSchema } from '@chatapp/contracts'
import { accounts, attachmentObjects, attachments, users } from '@chatapp/db'
import { createDatabase } from '@chatapp/db/client'
import { eq } from 'drizzle-orm'
import { sdkPasswords } from '../../src/auth/passwords.ts'
import { loadConfig } from '../../src/config/env.ts'

const assert = (value: unknown, label: string): void => {
  if (!value) throw new Error(`business-test: ${label}`)
}
export async function runBusinessFlow(baseUrl = 'http://api:3100'): Promise<void> {
  // The local gateway has a generated certificate which is never installed in a trust store.
  const request = (url: string, init: RequestInit = {}) =>
    fetch(url, {
      ...init,
      ...(baseUrl.startsWith('https:') ? { tls: { rejectUnauthorized: false } } : {}),
    })
  const data = JSON.parse(await new Response(Bun.stdin.stream()).text()) as {
    samples: Record<string, string>
  }
  const config = loadConfig(process.env),
    database = createDatabase(config.databaseUrl)
  const password = 'generated-test-only-strong-password'
  let count = 0
  async function account(name: string) {
    const [user] = await database.db
      .insert(users)
      .values({
        name,
        username: `m3_${name}`,
        email: `${name}@example.test`,
        emailVerified: true,
        activationStatus: 'active',
        accountSource: 'cli',
      })
      .returning()
    if (!user) throw new Error('business-test: user missing')
    await database.db.insert(accounts).values({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: await sdkPasswords.hash(password),
    })
    const response = await request(`${baseUrl}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: config.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password }),
    })
    assert(response.status === 200, 'real login')
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ')
    return { user, cookie }
  }
  const alice = await account('alice'),
    bob = await account('bobby'),
    outsider = await account('outsider')
  async function call(
    who: typeof alice,
    path: string,
    json?: unknown,
    method = json ? 'POST' : 'GET',
  ) {
    const response = await request(`${baseUrl}${path}`, {
      method,
      headers: {
        origin: config.origin,
        cookie: who.cookie,
        'content-type': 'application/json',
        'idempotency-key': crypto.randomUUID(),
      },
      ...(json ? { body: JSON.stringify(json) } : {}),
    })
    assert(response.ok, `HTTP ${response.status}`)
    return response.json() as Promise<Record<string, unknown>>
  }
  const group = await call(alice, '/api/conversations', {
    kind: 'group',
    name: 'M3 native business test',
    memberIds: [bob.user.id],
  })
  const channel = await call(alice, '/api/conversations', {
    kind: 'channel',
    name: 'M3 avatar channel',
  })
  async function upload(
    sample: string,
    purpose: 'message' | 'avatar' | 'conversation_avatar' = 'message',
    conversationId?: string,
  ) {
    const bytes =
      sample === 'limit'
        ? Buffer.alloc(UPLOAD_LIMITS.fileBytes, 0x61)
        : Buffer.from(data.samples[sample] ?? '', 'base64')
    const reservation = uploadSchema.parse(
      await call(alice, '/api/uploads/reservations', {
        purpose,
        name: `${sample}.input`,
        declaredSize: bytes.length,
        ...(conversationId ? { conversationId } : {}),
      }),
    )
    const response = await request(`${baseUrl}/api/uploads/${reservation.uploadId}/content`, {
      method: 'PUT',
      headers: {
        origin: config.origin,
        cookie: alice.cookie,
        'content-type': 'application/octet-stream',
      },
      body: bytes,
    })
    assert(response.status === 200, `stream receive ${sample} HTTP ${response.status}`)
    let result: Upload = uploadSchema.parse(await response.json())
    const deadline = Date.now() + 90_000
    while (result.status === 'processing' || result.status === 'uploading') {
      assert(Date.now() < deadline, 'real worker processing deadline')
      await new Promise((resolve) => setTimeout(resolve, 200))
      result = uploadSchema.parse(await call(alice, `/api/uploads/${reservation.uploadId}`))
    }
    assert(result.status === 'ready', 'published ready')
    if (!result.attachment) throw new Error('business-test: attachment missing')
    if (sample === 'jpeg' && purpose === 'message') {
      const replay = await request(`${baseUrl}/api/uploads/${reservation.uploadId}/content`, {
        method: 'PUT',
        headers: {
          origin: config.origin,
          cookie: alice.cookie,
          'content-type': 'application/octet-stream',
        },
        body: bytes,
      })
      assert(
        replay.status === 200 &&
          uploadSchema.parse(await replay.json()).attachment?.id === result.attachment.id,
        'complete PUT replay preserves attachment',
      )
      const changed = Buffer.from(bytes)
      changed[0] = (changed[0] ?? 0) ^ 1
      assert(
        (
          await request(`${baseUrl}/api/uploads/${reservation.uploadId}/content`, {
            method: 'PUT',
            headers: {
              origin: config.origin,
              cookie: alice.cookie,
              'content-type': 'application/octet-stream',
            },
            body: changed,
          })
        ).status === 409,
        'changed PUT replay is refused',
      )
    }
    count++
    return result.attachment
  }
  const images = []
  for (const name of ['jpeg', 'png', 'gif']) {
    const image = await upload(name, 'message', String(group.id))
    assert(
      image.kind === 'image' &&
        image.width &&
        image.height &&
        image.thumbhash &&
        image.urls.preview &&
        image.urls.thumb,
      'all image variants published',
    )
    for (const url of [image.urls.original, image.urls.preview, image.urls.thumb]) {
      const response = await request(`${baseUrl}${url}`, { headers: { cookie: alice.cookie } })
      assert(response.status === 200, 'uploader variant read')
      assert((await response.arrayBuffer()).byteLength > 0, 'variant has bytes')
    }
    images.push(image)
  }
  const video = await upload('video', 'message', String(group.id))
  assert(
    video.kind === 'video' &&
      video.durationMs &&
      video.mime === 'video/mp4' &&
      video.metadataCleared === true,
    'remuxed video published',
  )
  const fallback = await upload('ffv1', 'message', String(group.id))
  assert(
    fallback.kind === 'file' &&
      fallback.mime === 'application/octet-stream' &&
      fallback.metadataCleared === false,
    'unsupported video download only',
  )
  const large = await upload('limit', 'message', String(group.id))
  assert(
    large.kind === 'file' && large.sizeBytes === UPLOAD_LIMITS.fileBytes,
    'exactly 100 MiB accepted and settled',
  )
  const oversizedReservation = uploadSchema.parse(
    await call(bob, '/api/uploads/reservations', {
      purpose: 'message',
      name: 'oversized.bin',
      declaredSize: UPLOAD_LIMITS.fileBytes,
      conversationId: group.id,
    }),
  )
  const oversized = await request(
    `${baseUrl}/api/uploads/${oversizedReservation.uploadId}/content`,
    {
      method: 'PUT',
      headers: {
        origin: config.origin,
        cookie: bob.cookie,
        'content-type': 'application/octet-stream',
      },
      body: Buffer.alloc(UPLOAD_LIMITS.fileBytes + 1, 0x61),
    },
  )
  assert(oversized.status === 413, '100 MiB plus one is refused before receipt')
  const small = uploadSchema.parse(
    await call(bob, '/api/uploads/reservations', {
      purpose: 'message',
      name: 'small.bin',
      declaredSize: 5,
      conversationId: group.id,
    }),
  )
  const smallOversize = await request(`${baseUrl}/api/uploads/${small.uploadId}/content`, {
    method: 'PUT',
    headers: {
      origin: config.origin,
      cookie: bob.cookie,
      'content-type': 'application/octet-stream',
    },
    body: Buffer.alloc(6, 0x61),
  })
  assert(
    smallOversize.status === 413,
    'actual content route enforces the smaller reservation, below HTTP body budget',
  )
  const smallState = uploadSchema.parse(await call(bob, `/api/uploads/${small.uploadId}`))
  assert(
    smallState.status === 'failed' || smallState.status === 'deleting',
    'oversize route retires the actual reservation',
  )

  await call(bob, `/api/uploads/${oversizedReservation.uploadId}`, undefined, 'DELETE')
  const tail = await request(`${baseUrl}${large.urls.original}`, {
    headers: { cookie: alice.cookie, range: 'bytes=-20' },
  })
  assert(
    tail.status === 206 && Buffer.from(await tail.arrayBuffer()).equals(Buffer.alloc(20, 0x61)),
    'large file actual S3 bytes',
  )
  const avatar = await upload('jpeg', 'avatar')
  assert(avatar.width === 256 && avatar.height === 256, 'server avatar crop')
  const profile = await call(alice, '/api/me')
  const updated = await call(alice, '/api/me/avatar', {
    attachmentId: avatar.id,
    expectedVersion: profile.meVersion,
  })
  assert(typeof updated.avatarUrl === 'string', 'avatar pointer published')
  assert(
    (await request(`${baseUrl}${updated.avatarUrl}`, { headers: { cookie: outsider.cookie } }))
      .status === 200,
    'member avatar visibility',
  )
  const groupAvatar = await upload('png', 'conversation_avatar', String(group.id))
  const currentGroup = await call(alice, `/api/conversations/${group.id}`)
  const groupUpdate = await call(alice, `/api/conversations/${group.id}/avatar`, {
    attachmentId: groupAvatar.id,
    expectedVersion: currentGroup.metadataVersion,
  })
  assert(
    (
      await request(`${baseUrl}${groupUpdate.avatarUrl}`, {
        headers: { cookie: outsider.cookie },
      })
    ).status === 404,
    'private avatar visibility',
  )
  const channelAvatar = await upload('png', 'conversation_avatar', String(channel.id))
  const currentChannel = await call(alice, `/api/conversations/${channel.id}`)
  const channelUpdate = await call(alice, `/api/conversations/${channel.id}/avatar`, {
    attachmentId: channelAvatar.id,
    expectedVersion: currentChannel.metadataVersion,
  })
  assert(
    (
      await request(`${baseUrl}${channelUpdate.avatarUrl}`, {
        headers: { cookie: outsider.cookie },
      })
    ).status === 200,
    'channel avatar visibility',
  )
  const sent = await call(alice, `/api/conversations/${group.id}/messages`, {
    clientId: crypto.randomUUID(),
    body: `<@user:${bob.user.id}> attachments`,
    attachmentIds: [...images, video, fallback, large].map((file) => file.id),
  })
  const message = sent.message as { id: string; attachments: unknown[]; mentions: string[] }
  assert(
    message.attachments.length === 6 && message.mentions[0] === bob.user.id,
    'message projection',
  )
  const url = images[0]?.urls.original
  const partial = await request(`${baseUrl}${url}`, {
    headers: { cookie: bob.cookie, Range: 'bytes=0-19' },
  })
  assert(partial.status === 206 && (await partial.arrayBuffer()).byteLength === 20, 'real S3 range')
  await call(alice, `/api/messages/${message.id}/recall`, {})
  assert(
    (await request(`${baseUrl}${url}`, { headers: { cookie: bob.cookie, Range: 'bytes=0-' } }))
      .status === 404,
    'recall immediate denial',
  )
  const [accountRow] = await database.db.select().from(users).where(eq(users.id, alice.user.id))
  const readyRows = await database.db
    .select()
    .from(attachments)
    .where(eq(attachments.status, 'ready'))
  assert(
    accountRow?.storageUsedBytes === readyRows.reduce((sum, a) => sum + a.chargedBytes, 0),
    'quota exact after recall',
  )
  const ledger = await database.db.select().from(attachmentObjects)
  assert(
    ledger.filter((o) => o.status === 'live').every((o) => o.accounted && o.sha256),
    'live immutable ledger',
  )
  console.log(
    JSON.stringify({
      uploads: count,
      readyAvatars: readyRows.length,
      messageAttachments: 6,
      gateway: baseUrl.startsWith('https:'),
      upload100MiB: true,
      oversizeRejected: true,
      reservationLimitEnforced: true,
      metadataStatusPersisted: true,
      immutablePutReplay: true,
      realWorker: true,
      range: true,
      purposeVisibility: true,
      recallDenied: true,
      ledger: true,
    }),
  )
  await database.close()
}
