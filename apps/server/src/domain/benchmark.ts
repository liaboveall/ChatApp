/** Operator-owned synthetic dataset. No public endpoint imports it; it never removes or replaces existing records. */
import {
  accounts,
  appSettings,
  attachmentObjects,
  attachments,
  conversations,
  messages,
  siteStorage,
  users,
} from '@chatapp/db'
import { eq, sql } from 'drizzle-orm'
import type { Deps } from './deps.ts'
import { addMembers } from './membership.ts'
import { assertRestoreUnlocked } from './restore.ts'

export const BENCHMARK_DATA = {
  smoke: { users: 8, conversations: 3, messages: 120, objects: 3, objectSize: 4096 },
  full: {
    users: 1000,
    conversations: 200,
    messages: 1_000_000,
    objects: 100_000,
    objectSize: 107_375,
  },
} as const

/** Every account has a reachable room in each normal-load tier; the first room is the hot channel. */
export function benchmarkRoomPlan(profile: keyof typeof BENCHMARK_DATA) {
  const spec = BENCHMARK_DATA[profile]
  return Array.from({ length: spec.conversations }, (_, index) => {
    const size = Math.min(
      spec.users,
      index === 0
        ? 500
        : index <= 50
          ? 20
          : index <= 60
            ? 100
            : index <= 62
              ? 500
              : ([20, 100, 500][index % 3] ?? 20),
    )
    const offset =
      index === 0
        ? 0
        : index <= 50
          ? (index - 1) * 20
          : index <= 60
            ? (index - 51) * 100
            : index <= 62
              ? (index - 61) * 500
              : index * 17
    const tier: 'small' | 'medium' | 'large' =
      profile === 'smoke'
        ? ((['large', 'small', 'medium'] as const)[index] ?? 'small')
        : size === 20
          ? 'small'
          : size === 100
            ? 'medium'
            : 'large'
    return {
      members: Array.from({ length: size }, (_, i) => (offset + i) % spec.users),
      kind: tier === 'large' ? ('channel' as const) : ('group' as const),
      tier,
    }
  })
}

export async function seedBenchmark(
  deps: Deps,
  runId: string,
  profile: keyof typeof BENCHMARK_DATA,
  io: {
    passwordHash: string
    putObject(key: string, size: number): Promise<{ size: number; sha256: string }>
    progress(phase: string, completed: number, total: number): void
  },
) {
  await assertRestoreUnlocked(deps.db)
  const spec = BENCHMARK_DATA[profile],
    prefix = `bench_${runId.replaceAll('-', '').slice(0, 8)}`
  await deps.db.insert(appSettings).values({
    key: `benchmark.${runId}`,
    value: { profile, status: 'preparing', startedAt: deps.clock.now().toISOString() },
  })
  // Duplicate run ID rejects before creating any new user; a failed run's original evidence stays in place.
  const members = Array.from({ length: spec.users }, (_, index) => ({
    id: deps.newId(),
    name: `${prefix}_${index}`,
    email: `${prefix}_${index}@benchmark.invalid`,
  }))
  const rooms: {
    id: string
    owner: string
    members: string[]
    kind: 'group' | 'channel'
    tier: 'small' | 'medium' | 'large'
    nextSeq: number
  }[] = []
  for (let offset = 0; offset < members.length; offset += 100) {
    const group = members.slice(offset, offset + 100)
    await deps.db.transaction(async (tx) => {
      await tx.insert(users).values(
        group.map((user) => ({
          id: user.id,
          username: user.name,
          name: user.name,
          email: user.email,
          emailVerified: true,
          activationStatus: 'active' as const,
          accountSource: 'cli' as const,
          inviteQuota: 0,
          aiDailyTokens: 0,
        })),
      )
      await tx.insert(accounts).values(
        group.map((user) => ({
          userId: user.id,
          accountId: user.id,
          providerId: 'credential',
          password: io.passwordHash,
        })),
      )
    })
    io.progress('users', Math.min(offset + 100, members.length), members.length)
  }
  for (const [index, plan] of benchmarkRoomPlan(profile).entries()) {
    const picked = plan.members.map((memberIndex) => {
      const member = members[memberIndex]
      if (!member) throw new Error('benchmark member missing')
      return member.id
    })
    const owner = picked[0]
    if (!owner) throw new Error('benchmark owner missing')
    const room = {
      id: deps.newId(),
      owner,
      members: picked,
      kind: plan.kind,
      tier: plan.tier,
      nextSeq: 0,
    }
    await deps.db.transaction(async (tx) => {
      await tx.insert(conversations).values({
        id: room.id,
        kind: room.kind,
        name: `${prefix} ${index}`,
        ownerId: owner,
        createdBy: owner,
        settings: { agentEnabled: false },
        createdAt: deps.clock.now(),
      })
      await addMembers(
        tx,
        deps,
        { id: room.id, kind: room.kind, lastSeq: 0 },
        picked.map((id) => ({
          userId: id,
          role: id === owner ? 'owner' : 'member',
          addedBy: owner,
        })),
        { fromStart: true },
      )
    })
    rooms.push(room)
  }
  const objectTargets: { id: string; roomId: string; userId: string }[] = []
  for (let offset = 0; offset < spec.messages; offset += 500) {
    const batch = Array.from({ length: Math.min(500, spec.messages - offset) }, (_, i) => {
      const position = offset + i,
        room = rooms[position % rooms.length]
      if (!room) throw new Error('benchmark room missing')
      const sender = room.members[Math.floor(position / rooms.length) % room.members.length]
      if (!sender) throw new Error('benchmark sender missing')
      const id = deps.newId()
      room.nextSeq++
      if (position < spec.objects) objectTargets.push({ id, roomId: room.id, userId: sender })
      return {
        id,
        conversationId: room.id,
        senderId: sender,
        seq: room.nextSeq,
        changeSeq: room.nextSeq,
        kind: 'user' as const,
        executionSource: 'system' as const,
        body: `Synthetic capacity record ${position}: ${'benchmark chat data '.repeat(50)}`,
        createdAt: new Date(deps.clock.now().getTime() - 8 * 86_400_000),
      }
    })
    await deps.db.transaction(async (tx) => {
      await tx.insert(messages).values(batch)
      for (const room of rooms.filter((room) =>
        batch.some((item) => item.conversationId === room.id),
      ))
        await tx
          .update(conversations)
          .set({
            lastSeq: room.nextSeq,
            lastChangeSeq: room.nextSeq,
            changeLogFloor: room.nextSeq,
            lastMessageAt: new Date(deps.clock.now().getTime() - 8 * 86_400_000),
          })
          .where(eq(conversations.id, room.id))
    })
    if (offset % 5000 === 0) io.progress('messages', offset + batch.length, spec.messages)
  }
  let bytes = 0
  for (const [index, target] of objectTargets.entries()) {
    const id = deps.newId(),
      key = `att/${id}/1/original`
    const object = await io.putObject(key, spec.objectSize)
    if (object.size !== spec.objectSize || !/^[a-f0-9]{64}$/.test(object.sha256))
      throw new Error('benchmark object verification failed')
    await deps.db.transaction(async (tx) => {
      await tx.insert(attachments).values({
        id,
        uploaderId: target.userId,
        conversationId: target.roomId,
        messageId: target.id,
        purpose: 'message',
        kind: 'file',
        mime: 'application/octet-stream',
        originalName: 'benchmark.bin',
        rawSizeBytes: object.size,
        sizeBytes: object.size,
        chargedBytes: object.size,
        sha256: object.sha256,
        storageKey: key,
        status: 'ready',
        position: 0,
      })
      await tx.insert(attachmentObjects).values({
        attachmentId: id,
        generation: 1,
        variant: 'original',
        storageKey: key,
        sizeBytes: object.size,
        sha256: object.sha256,
        status: 'live',
        accounted: true,
      })
      await tx
        .update(users)
        .set({ storageUsedBytes: sql`${users.storageUsedBytes}+${object.size}` })
        .where(eq(users.id, target.userId))
      await tx
        .insert(siteStorage)
        .values({ id: 1, usedBytes: object.size })
        .onConflictDoUpdate({
          target: siteStorage.id,
          set: { usedBytes: sql`${siteStorage.usedBytes}+${object.size}` },
        })
    })
    bytes += object.size
    if (index % 100 === 0) io.progress('objects', index + 1, spec.objects)
  }
  const result = {
    users: members,
    messagingRoomId: rooms[0]?.id ?? '',
    messagingTargets: Object.fromEntries(
      members.map((user) => [
        user.id,
        {
          small: rooms
            .filter((room) => room.tier === 'small' && room.members.includes(user.id))
            .map((room) => room.id),
          medium: rooms
            .filter((room) => room.tier === 'medium' && room.members.includes(user.id))
            .map((room) => room.id),
          large: rooms
            .filter((room) => room.tier === 'large' && room.members.includes(user.id))
            .map((room) => room.id),
        },
      ]),
    ),

    dataset: {
      users: members.length,
      conversations: rooms.length,
      messages: spec.messages,
      objects: spec.objects,
      objectBytes: bytes,
    },
  }
  await deps.db
    .update(appSettings)
    .set({
      value: {
        profile,
        status: 'ready',
        dataset: result.dataset,
        userIds: members.map((user) => user.id),
        conversationIds: rooms.map((room) => room.id),
      },
    })
    .where(eq(appSettings.key, `benchmark.${runId}`))
  return result
}
