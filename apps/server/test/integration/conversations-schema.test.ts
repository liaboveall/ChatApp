/**
 * Database-level guarantees of the M2a tables (docs/04 sections 2 and 3): the constraints, indexes and the deferred
 * owner/DM checks hold even when the application code is wrong (INV-01, INV-04, INV-08, INV-23, L-03).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  conversationMembers,
  conversations,
  dmPairs,
  messageHidden,
  messages,
  type Tx,
  users,
} from '@chatapp/db'
import { and, eq, sql } from 'drizzle-orm'
import { pgErrorInfo } from '../../src/lib/pg-error.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { createActiveUser, makeDeps } from '../support/deps.ts'

let dbs: TestDatabases

beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
})

async function failure(
  run: () => Promise<unknown>,
): Promise<{ code?: string; constraint?: string } | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    const info = pgErrorInfo(error)
    return { code: info?.sqlState, constraint: info?.constraint }
  }
}

const person = async (name: string) =>
  (await createActiveUser(makeDeps(dbs.owner.db), { username: name })).id

type Kind = 'channel' | 'group'

/** A conversation with its owner member, created the way the domain does: both rows in one transaction. */
async function createConversation(
  kind: Kind,
  name: string,
  ownerId: string,
  extra: Partial<typeof conversations.$inferInsert> = {},
): Promise<string> {
  return await dbs.app.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(conversations)
      .values({ kind, name, ownerId, createdBy: ownerId, memberCount: 1, ...extra })
      .returning({ id: conversations.id })
    const id = row?.id ?? ''
    await tx
      .insert(conversationMembers)
      .values({ conversationId: id, userId: ownerId, role: 'owner', notifyLevel: 'mentions' })
    return id
  })
}

describe('channel names (L-03)', () => {
  test('are unique among live channels, ignoring case and full-width forms; groups may repeat', async () => {
    const owner = await person('owner1')
    await createConversation('channel', '测试房间', owner)
    expect(
      (await failure(() => createConversation('channel', '测试房间', owner)))?.constraint,
    ).toBe('conversations_channel_name_uidx')
    await createConversation('channel', 'Lobby', owner)
    // Full-width letters and different case fold to the same name under NFKC + lower.
    expect(
      (await failure(() => createConversation('channel', 'ＬＯＢＢＹ', owner)))?.constraint,
    ).toBe('conversations_channel_name_uidx')
    expect((await failure(() => createConversation('channel', 'lobby', owner)))?.constraint).toBe(
      'conversations_channel_name_uidx',
    )
    // Two different Chinese names (the legacy bug) and a repeated group name are fine.
    await createConversation('channel', '另一个房间', owner)
    await createConversation('group', '测试房间', owner)
    await createConversation('group', '测试房间', owner)
  })

  test('an archived channel gives its name back', async () => {
    const owner = await person('owner2')
    const id = await createConversation('channel', 'Reusable', owner)
    await dbs.app.db
      .update(conversations)
      .set({ archivedAt: new Date() })
      .where(eq(conversations.id, id))
    await createConversation('channel', 'reusable', owner)
  })

  test('a direct message has no name and every other kind has one', async () => {
    const owner = await person('owner3')
    expect(
      (
        await failure(() =>
          dbs.app.db.insert(conversations).values({ kind: 'dm', name: 'x', createdBy: owner }),
        )
      )?.constraint,
    ).toBe('conversations_name_by_kind')
    expect(
      (
        await failure(() =>
          dbs.app.db
            .insert(conversations)
            .values({ kind: 'group', createdBy: owner, ownerId: owner }),
        )
      )?.constraint,
    ).toBe('conversations_name_by_kind')
  })
})

describe('exactly one owner (INV-23)', () => {
  test('a live channel or group without an owner member does not commit', async () => {
    const owner = await person('owner4')
    const noOwner = await failure(() =>
      dbs.app.db
        .insert(conversations)
        .values({ kind: 'group', name: 'orphan', ownerId: owner, createdBy: owner }),
    )
    expect(noOwner?.constraint).toBe('conversations_owner_consistent')
  })

  test('owner_id must name the owner member', async () => {
    const owner = await person('owner5')
    const other = await person('other5')
    const mismatch = await failure(() =>
      dbs.app.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(conversations)
          .values({ kind: 'group', name: 'mismatch', ownerId: other, createdBy: owner })
          .returning({ id: conversations.id })
        await tx.insert(conversationMembers).values({
          conversationId: row?.id ?? '',
          userId: owner,
          role: 'owner',
          notifyLevel: 'mentions',
        })
      }),
    )
    expect(mismatch?.constraint).toBe('conversations_owner_consistent')
  })

  test('a second owner member is refused at once', async () => {
    const owner = await person('owner6')
    const other = await person('other6')
    const id = await createConversation('group', 'two owners', owner)
    const second = await failure(() =>
      dbs.app.db
        .insert(conversationMembers)
        .values({ conversationId: id, userId: other, role: 'owner', notifyLevel: 'mentions' }),
    )
    expect(second?.constraint).toBe('conversation_members_one_owner_uidx')
  })

  test('a transfer that demotes first and promotes second, in one transaction, commits', async () => {
    const owner = await person('owner7')
    const heir = await person('heir7')
    const id = await createConversation('group', 'handover', owner)
    await dbs.app.db
      .insert(conversationMembers)
      .values({ conversationId: id, userId: heir, role: 'member', notifyLevel: 'mentions' })
    await dbs.app.db.transaction(async (tx: Tx) => {
      await tx
        .update(conversationMembers)
        .set({ role: 'admin' })
        .where(
          and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, owner)),
        )
      await tx
        .update(conversationMembers)
        .set({ role: 'owner' })
        .where(
          and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, heir)),
        )
      await tx.update(conversations).set({ ownerId: heir }).where(eq(conversations.id, id))
    })
    // Promoting without moving owner_id (or the other way round) is caught at commit.
    const half = await failure(() =>
      dbs.app.db.update(conversations).set({ ownerId: owner }).where(eq(conversations.id, id)),
    )
    expect(half?.constraint).toBe('conversations_owner_consistent')
  })

  test('removing the owner member of a live conversation does not commit; an archived one may be empty', async () => {
    const owner = await person('owner8')
    const id = await createConversation('group', 'leaving', owner)
    const removed = await failure(() =>
      dbs.app.db.delete(conversationMembers).where(eq(conversationMembers.conversationId, id)),
    )
    expect(removed?.constraint).toBe('conversations_owner_consistent')
    // The only member leaves and the conversation is archived in the same transaction (docs/04).
    await dbs.app.db.transaction(async (tx) => {
      await tx
        .update(conversations)
        .set({ archivedAt: new Date(), memberCount: 0 })
        .where(eq(conversations.id, id))
      await tx.delete(conversationMembers).where(eq(conversationMembers.conversationId, id))
    })
    expect(await dbs.app.db.select().from(conversationMembers)).toHaveLength(0)
  })
})

describe('direct messages (INV-04)', () => {
  async function dm(userIds: string[]): Promise<string> {
    return await dbs.app.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(conversations)
        .values({ kind: 'dm', createdBy: userIds[0] ?? '', memberCount: userIds.length })
        .returning({ id: conversations.id })
      const id = row?.id ?? ''
      for (const userId of userIds) {
        await tx
          .insert(conversationMembers)
          .values({ conversationId: id, userId, notifyLevel: 'all' })
      }
      return id
    })
  }

  test('has exactly two members', async () => {
    const [a, b, c] = [await person('dma'), await person('dmb'), await person('dmc')]
    expect((await failure(() => dm([a])))?.constraint).toBe('conversations_dm_two_members')
    expect((await failure(() => dm([a, b, c])))?.constraint).toBe('conversations_dm_two_members')
    await dm([a, b])
  })

  test('one conversation per pair, stored with the smaller id first', async () => {
    const [a, b] = [await person('dmd'), await person('dme')]
    const [low, high] = a < b ? [a, b] : [b, a]
    const first = await dm([a, b])
    await dbs.app.db.insert(dmPairs).values({ userLow: low, userHigh: high, conversationId: first })
    const second = await dm([a, b])
    expect(
      (
        await failure(() =>
          dbs.app.db
            .insert(dmPairs)
            .values({ userLow: low, userHigh: high, conversationId: second }),
        )
      )?.code,
    ).toBe('23505')
    const wrongWay = await failure(() =>
      dbs.app.db.insert(dmPairs).values({ userLow: high, userHigh: low, conversationId: second }),
    )
    expect(wrongWay?.constraint).toBe('dm_pairs_ordered')
  })

  test('a direct message has no owner', async () => {
    const a = await person('dmf')
    expect(
      (
        await failure(() =>
          dbs.app.db.insert(conversations).values({ kind: 'dm', createdBy: a, ownerId: a }),
        )
      )?.constraint,
    ).toBe('conversations_dm_has_no_owner')
  })
})

describe('member rows (INV-08, INV-30)', () => {
  test('the read position never starts below the visible boundary', async () => {
    const owner = await person('owner9')
    const other = await person('other9')
    const id = await createConversation('group', 'positions', owner)
    expect(
      (
        await failure(() =>
          dbs.app.db.insert(conversationMembers).values({
            conversationId: id,
            userId: other,
            notifyLevel: 'mentions',
            visibleFromSeq: 10,
            lastReadSeq: 4,
          }),
        )
      )?.constraint,
    ).toBe('conversation_members_seq_order')
  })

  test('only an `until` mute carries a finite time (no infinity)', async () => {
    const owner = await person('owner10')
    const id = await createConversation('group', 'mute', owner)
    const key = and(
      eq(conversationMembers.conversationId, id),
      eq(conversationMembers.userId, owner),
    )
    expect(
      (
        await failure(() =>
          dbs.app.db.update(conversationMembers).set({ muteMode: 'until' }).where(key),
        )
      )?.constraint,
    ).toBe('conversation_members_mute_pair')
    expect(
      (
        await failure(() =>
          dbs.app.db
            .update(conversationMembers)
            .set({ muteMode: 'forever', mutedUntil: new Date() })
            .where(key),
        )
      )?.constraint,
    ).toBe('conversation_members_mute_pair')
    // `until` with a time, and `forever` with none, are the two valid shapes.
    await dbs.app.db
      .update(conversationMembers)
      .set({ muteMode: 'until', mutedUntil: new Date(Date.now() + 60_000) })
      .where(key)
    await dbs.app.db
      .update(conversationMembers)
      .set({ muteMode: 'forever', mutedUntil: null })
      .where(key)
  })

  test('membership ids are unique and generated per row', async () => {
    const owner = await person('owner11')
    const other = await person('other11')
    const id = await createConversation('group', 'ids', owner)
    await dbs.app.db
      .insert(conversationMembers)
      .values({ conversationId: id, userId: other, notifyLevel: 'mentions' })
    const rows = await dbs.app.db
      .select({ membershipId: conversationMembers.membershipId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, id))
    expect(new Set(rows.map((row) => row.membershipId)).size).toBe(2)
    expect(rows[0]?.membershipId.split('-')[2]?.[0]).toBe('7') // UUIDv7
  })
})

describe('messages (INV-01, INV-03, INV-06)', () => {
  async function seeded() {
    const owner = await person(`m${Math.random().toString(36).slice(2, 8)}`)
    const id = await createConversation('group', 'messages', owner)
    return { owner, id }
  }
  const base = (conversationId: string, senderId: string, seq: number) => ({
    conversationId,
    seq,
    changeSeq: seq,
    senderId,
    kind: 'user' as const,
    body: 'hi',
    executionSource: 'interactive' as const,
  })

  test('a sequence number is used once per conversation and a client id once per sender', async () => {
    const { owner, id } = await seeded()
    await dbs.app.db
      .insert(messages)
      .values({ ...base(id, owner, 1), clientId: crypto.randomUUID() })
    expect(
      (await failure(() => dbs.app.db.insert(messages).values(base(id, owner, 1))))?.constraint,
    ).toBe('messages_conversation_seq_uidx')
    const clientId = crypto.randomUUID()
    await dbs.app.db.insert(messages).values({ ...base(id, owner, 2), clientId })
    expect(
      (await failure(() => dbs.app.db.insert(messages).values({ ...base(id, owner, 3), clientId })))
        ?.constraint,
    ).toBe('messages_sender_client_uidx')
  })

  test('only system messages may have no sender, and a change never precedes its creation', async () => {
    const { owner, id } = await seeded()
    expect(
      (
        await failure(() =>
          dbs.app.db.insert(messages).values({ ...base(id, owner, 1), senderId: null }),
        )
      )?.constraint,
    ).toBe('messages_sender_unless_system')
    await dbs.app.db.insert(messages).values({
      ...base(id, owner, 1),
      senderId: null,
      kind: 'system',
      executionSource: 'system',
      body: null,
    })
    expect(
      (
        await failure(() =>
          dbs.app.db.insert(messages).values({ ...base(id, owner, 5), changeSeq: 4 }),
        )
      )?.constraint,
    ).toBe('messages_seq_order')
  })

  test('a recalled or deleted message keeps no body and ends only one way', async () => {
    const { owner, id } = await seeded()
    const [message] = await dbs.app.db
      .insert(messages)
      .values(base(id, owner, 1))
      .returning({ id: messages.id })
    const key = eq(messages.id, message?.id ?? '')
    expect(
      (await failure(() => dbs.app.db.update(messages).set({ recalledAt: new Date() }).where(key)))
        ?.constraint,
    ).toBe('messages_cleared_when_gone')
    await dbs.app.db.update(messages).set({ recalledAt: new Date(), body: null }).where(key)
    expect(
      (
        await failure(() =>
          dbs.app.db.update(messages).set({ deletedAt: new Date(), deletedBy: owner }).where(key),
        )
      )?.constraint,
    ).toBe('messages_one_ending')
  })

  test('deleting a conversation removes its messages and hidden marks', async () => {
    const { owner, id } = await seeded()
    const [message] = await dbs.app.db
      .insert(messages)
      .values(base(id, owner, 1))
      .returning({ id: messages.id })
    await dbs.app.db.insert(messageHidden).values({ userId: owner, messageId: message?.id ?? '' })
    await dbs.owner.db.delete(conversations).where(eq(conversations.id, id))
    expect(await dbs.owner.db.select().from(messages)).toHaveLength(0)
    expect(await dbs.owner.db.select().from(messageHidden)).toHaveLength(0)
    // The author's account is untouched.
    expect(await dbs.owner.db.select({ id: users.id }).from(users)).toHaveLength(1)
  })
})

describe('allocation counters (INV-01)', () => {
  test('last_change_seq never falls behind last_seq and the log floor never passes the head', async () => {
    const owner = await person('owner12')
    const id = await createConversation('group', 'counters', owner)
    expect(
      (
        await failure(() =>
          dbs.app.db
            .update(conversations)
            .set({ lastSeq: 5, lastChangeSeq: 4 })
            .where(eq(conversations.id, id)),
        )
      )?.constraint,
    ).toBe('conversations_counters')
    expect(
      (
        await failure(() =>
          dbs.app.db
            .update(conversations)
            .set({ lastSeq: 2, lastChangeSeq: 2, changeLogFloor: 3 })
            .where(eq(conversations.id, id)),
        )
      )?.constraint,
    ).toBe('conversations_counters')
  })

  test('one UPDATE ... RETURNING hands every concurrent writer a distinct pair', async () => {
    const owner = await person('owner13')
    const id = await createConversation('group', 'concurrent', owner)
    const takes = await Promise.all(
      Array.from({ length: 20 }, () =>
        dbs.app.db
          .update(conversations)
          .set({
            lastSeq: sql`${conversations.lastSeq} + 1`,
            lastChangeSeq: sql`${conversations.lastChangeSeq} + 1`,
          })
          .where(eq(conversations.id, id))
          .returning({ seq: conversations.lastSeq, changeSeq: conversations.lastChangeSeq }),
      ),
    )
    const seqs = takes.map((rows) => rows[0]?.seq).sort((a, b) => (a ?? 0) - (b ?? 0))
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 1))
    expect(new Set(takes.map((rows) => rows[0]?.changeSeq)).size).toBe(20)
  })
})
