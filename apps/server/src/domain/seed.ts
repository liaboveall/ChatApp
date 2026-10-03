/**
 * Development-only demo content (docs/09): a channel, a second channel one of the three is not in, a group and a direct
 * message, with three days of talk. It is written through the same domain functions the interface uses, so every row is
 * what the application itself would have made (sequence numbers, sync logs, read positions). The CLI refuses to run it
 * in production. Idempotent: a conversation that already exists is left alone, whatever was said in it since.
 */
import { AppError } from '@chatapp/contracts'
import { authorizationOrigins, conversations, messages, sessions, users } from '@chatapp/db'
import { and, eq, inArray } from 'drizzle-orm'
import { ManualClock } from '../lib/clock.ts'
import {
  createConversation,
  getConversation,
  joinConversation,
  markConversationRead,
  openDirectMessage,
  updateMyConversationSettings,
} from './conversations.ts'
import type { Deps } from './deps.ts'
import { sendMessage } from './messages.ts'
import type { SessionPrincipal } from './principal.ts'

const MINUTE = 60_000

export const DEMO_USERNAMES = ['alice', 'bob', 'carol'] as const
type DemoName = (typeof DEMO_USERNAMES)[number]

type Line = {
  by: DemoName
  text: string
  /** Minutes since the line before it. */
  gap: number
  /** Index of an earlier line this one answers. */
  reply?: number
}

const GENERAL: Line[] = [
  { by: 'alice', gap: 0, text: '大家好，欢迎来到综合讨论 👋' },
  { by: 'bob', gap: 3, text: '终于有地方可以聊了' },
  { by: 'carol', gap: 2, text: '这个界面比之前好看多了，玻璃一样的质感' },
  {
    by: 'alice',
    gap: 4,
    text: '整个重写过，旧版已经归档了。有什么想要的功能直接在这里说',
    reply: 2,
  },
  { by: 'bob', gap: 6, text: '消息可以撤回和编辑吗？' },
  { by: 'alice', gap: 1, text: '可以。发出后两分钟内能撤回，24 小时内能编辑', reply: 4 },
  {
    by: 'carol',
    gap: 8,
    text: '我来试一条没有标点也没有空格的长消息，看窄窗口里会不会折行：这是一段很长很长的中文用来检查文字在气泡里能不能自动换行而不撑破布局',
  },
  { by: 'bob', gap: 2, text: '哈哈，这条可以留着当测试用例' },
  {
    by: 'alice',
    gap: 3,
    text: 'English works too: the quick brown fox jumps over the lazy dog, and then keeps running through the whole conversation list without breaking anything.',
  },
  { by: 'carol', gap: 9 * 60, text: '早上好 ☀️' },
  { by: 'bob', gap: 12, text: '早，今天要不要把周末的计划定一下？' },
  { by: 'alice', gap: 5, text: '我在“周末爬山”那个群里发了几个选项，大家看一眼', reply: 10 },
  { by: 'carol', gap: 7, text: '好的，我去看' },
  { by: 'bob', gap: 40, text: '顺便问一下，频道里的消息新加入的人能看到之前的吗？' },
  {
    by: 'alice',
    gap: 2,
    text: '看不到。新成员只能看到加入之后的消息，这是有意这样设计的',
    reply: 13,
  },
  { by: 'bob', gap: 1, text: '明白了，挺合理的' },
  { by: 'carol', gap: 22 * 60, text: '昨晚的讨论我整理成了一份笔记，晚点贴出来' },
  { by: 'alice', gap: 18, text: '辛苦了！' },
  { by: 'bob', gap: 35, text: '我这边也有一点补充，下午发给你' },
  { by: 'carol', gap: 3 * 60, text: '笔记已经放好了，大家有空看看，有问题随时在这里提', reply: 16 },
  { by: 'alice', gap: 9, text: '收到，我今晚看' },
  { by: 'bob', gap: 14, text: '我先看了一遍，写得很清楚 👍' },
  { by: 'carol', gap: 4, text: '谢谢！' },
  { by: 'bob', gap: 26, text: '对了，明天有人一起吃午饭吗？' },
  { by: 'alice', gap: 8, text: '我可以，12 点楼下见' },
  { by: 'carol', gap: 3, text: '我也去 🍜' },
]

const TECH: Line[] = [
  { by: 'bob', gap: 0, text: '这个频道聊技术：TypeScript、数据库、各种工具，随意' },
  { by: 'carol', gap: 11, text: 'PostgreSQL 18 的异步 IO 有人试过吗？' },
  { by: 'bob', gap: 6, text: '试了一下，顺序扫描的吞吐确实明显提升', reply: 1 },
  { by: 'carol', gap: 3, text: '那我们的日志表可以考虑再加一个分区' },
  { by: 'bob', gap: 5 * 60, text: '昨天的压测结果出来了，发送到接收在本机上快得很' },
  { by: 'carol', gap: 4, text: '这个结果很好看' },
  {
    by: 'bob',
    gap: 2,
    text: '别高兴太早，真正的网络上还会多出几十毫秒，目标是 200 毫秒以内',
    reply: 5,
  },
  {
    by: 'carol',
    gap: 30,
    text: 'Valkey 的订阅在重连之后会丢事件，所以客户端要靠 changes 接口补齐，对吧？',
  },
  { by: 'bob', gap: 3, text: '对，提示只是提示，真相永远在数据库里', reply: 7 },
  { by: 'carol', gap: 20 * 60, text: '早，今天先把 changes 的重置路径再测一遍' },
  { by: 'bob', gap: 9, text: '好，我来写游标过期的那个用例' },
  { by: 'bob', gap: 12, text: '写完叫你一起看' },
]

const HIKE: Line[] = [
  { by: 'alice', gap: 0, text: '周末爬山的选项：A 香山，B 百望山，C 凤凰岭。大家投个票' },
  { by: 'bob', gap: 7, text: '我选 A，近一点' },
  { by: 'carol', gap: 3, text: '我也 A，不过要早点出发，人太多的话上山很慢' },
  { by: 'alice', gap: 2, text: '那就 A。周六早上 8 点地铁口集合？', reply: 2 },
  { by: 'bob', gap: 4, text: '可以' },
  { by: 'carol', gap: 1, text: '没问题' },
  { by: 'alice', gap: 14 * 60, text: '提醒一下：带水，穿舒服的鞋，天气预报下午可能有雨' },
  { by: 'bob', gap: 22, text: '收到，我带两瓶水' },
  { by: 'carol', gap: 10, text: '我带点吃的，大家有忌口吗？' },
  { by: 'alice', gap: 3, text: '我没有' },
  { by: 'bob', gap: 2, text: '我也没有' },
  { by: 'alice', gap: 6 * 60, text: '明天见！' },
  { by: 'carol', gap: 12, text: '明天见 🏔️' },
]

/** The direct message between Alice and Bob. */
const DIRECT: Line[] = [
  { by: 'alice', gap: 0, text: '嗨，Bob，在吗？' },
  { by: 'bob', gap: 9, text: '在的，怎么了？' },
  { by: 'alice', gap: 2, text: '想问问你周末那份测试报告写到哪了' },
  { by: 'bob', gap: 5, text: '写了一半，明天中午前给你', reply: 2 },
  { by: 'alice', gap: 1, text: '好，不急' },
  { by: 'bob', gap: 4 * 60, text: '报告发你了，你看看有没有问题' },
  { by: 'alice', gap: 25, text: '收到，我先看看' },
  { by: 'alice', gap: 11, text: '第三节的数据好像对不上，能再核对一下吗？' },
]

export type SeedResult = {
  conversationsCreated: number
  conversationsPresent: number
  messagesSent: number
}

type Principals = Record<DemoName, SessionPrincipal>

/** The demo people sign in nowhere: their principals stand on short-lived rows that are removed again. */
async function withPrincipals<T>(
  deps: Deps,
  run: (principals: Principals) => Promise<T>,
): Promise<T> {
  const people = await deps.db
    .select()
    .from(users)
    .where(inArray(users.username, [...DEMO_USERNAMES]))
  const originIds: string[] = []
  const sessionIds: string[] = []
  const principals = {} as Principals
  for (const name of DEMO_USERNAMES) {
    const user = people.find((row) => row.username === name)
    if (!user) throw new AppError('NOT_FOUND', `demo member ${name} does not exist`)
    const [origin] = await deps.db
      .insert(authorizationOrigins)
      .values({ userId: user.id, restoreEpoch: deps.config.auth.restoreEpoch })
      .returning({ id: authorizationOrigins.id })
    if (!origin) throw new Error('origin was not created')
    originIds.push(origin.id)
    const [session] = await deps.db
      .insert(sessions)
      .values({
        userId: user.id,
        token: `seed-${deps.newId()}`,
        expiresAt: new Date(Date.now() + 60 * MINUTE),
        authEpoch: user.authEpoch,
        authorizationOriginId: origin.id,
      })
      .returning({ id: sessions.id })
    if (!session) throw new Error('session was not created')
    sessionIds.push(session.id)
    principals[name] = {
      kind: 'session',
      userId: user.id,
      sessionId: session.id,
      originId: origin.id,
      authEpoch: user.authEpoch,
      restoreEpoch: deps.config.auth.restoreEpoch,
      role: user.role,
    }
  }
  try {
    return await run(principals)
  } finally {
    // Only what was made here: somebody may really be signed in as a demo member.
    await deps.db.delete(sessions).where(inArray(sessions.id, sessionIds))
    await deps.db.delete(authorizationOrigins).where(inArray(authorizationOrigins.id, originIds))
  }
}

export async function seedDemoContent(deps: Deps): Promise<SeedResult> {
  const result: SeedResult = { conversationsCreated: 0, conversationsPresent: 0, messagesSent: 0 }
  // The talk is backdated so the interface has days to show; it ends a few minutes ago.
  const clock = new ManualClock(Date.now())
  const timed: Deps = { ...deps, clock }

  await withPrincipals(deps, async (P) => {
    /** Plays a script into a conversation that was just created; returns the sequence number of the last line. */
    const play = async (conversationId: string, script: Line[]): Promise<number> => {
      const span = script.reduce((sum, line) => sum + line.gap, 0) * MINUTE
      let at = Date.now() - 6 * MINUTE - span
      const ids: string[] = []
      let last = 0
      for (const [index, line] of script.entries()) {
        at += line.gap * MINUTE
        clock.set(at)
        const sent = await sendMessage(timed, P[line.by], conversationId, {
          clientId: crypto.randomUUID(),
          body: line.text,
          ...(line.reply === undefined ? {} : { replyToId: ids[line.reply] ?? null }),
        })
        ids[index] = sent.envelope.message.id
        last = sent.envelope.message.seq
        result.messagesSent += 1
      }
      return last
    }
    const begin = (script: Line[]) => {
      const span = script.reduce((sum, line) => sum + line.gap, 0) * MINUTE
      clock.set(Date.now() - 6 * MINUTE - span - 5 * MINUTE)
    }
    // Sending moves the sender's own read position, so whoever spoke last is the one with nothing unread. Only Alice,
    // who reads everything, is brought up to date by hand.
    const readAll = async (who: DemoName, conversationId: string, seq: number) => {
      await markConversationRead(timed, P[who], conversationId, seq)
    }
    const pin = async (who: DemoName, conversationId: string) => {
      const view = await getConversation(timed, P[who], conversationId)
      await updateMyConversationSettings(timed, P[who], conversationId, {
        expectedViewerVersion: view.viewerVersion,
        pinned: true,
      })
    }

    // — a channel everyone joins —
    const channel = await ensureChannel(deps, timed, P.alice, begin, GENERAL, {
      name: '综合讨论',
      description: '随便聊聊，什么话题都可以',
    })
    if (channel.created) {
      result.conversationsCreated += 1
      await joinConversation(timed, P.bob, channel.id)
      await joinConversation(timed, P.carol, channel.id)
      const last = await play(channel.id, GENERAL)
      await readAll('alice', channel.id, last)
      await pin('alice', channel.id)
    } else {
      result.conversationsPresent += 1
    }

    // — a channel Alice is not in, to find under "browse channels" —
    const tech = await ensureChannel(deps, timed, P.bob, begin, TECH, {
      name: '技术闲聊',
      description: 'TypeScript、数据库和各种工具',
    })
    if (tech.created) {
      result.conversationsCreated += 1
      await joinConversation(timed, P.carol, tech.id)
      await play(tech.id, TECH)
    } else {
      result.conversationsPresent += 1
    }

    // — a private group —
    const [existingGroup] = await deps.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.kind, 'group'),
          eq(conversations.name, '周末爬山'),
          eq(conversations.ownerId, P.alice.userId),
        ),
      )
    if (existingGroup) {
      result.conversationsPresent += 1
    } else {
      begin(HIKE)
      const group = await createConversation(
        timed,
        P.alice,
        { kind: 'group', name: '周末爬山', memberIds: [P.bob.userId, P.carol.userId] },
        crypto.randomUUID(),
      )
      result.conversationsCreated += 1
      const last = await play(group.conversation.id, HIKE)
      await readAll('alice', group.conversation.id, last)
    }

    // — a direct message between Alice and Bob; the last two lines are Alice's, so Bob has two unread —
    begin(DIRECT)
    const opened = await openDirectMessage(timed, P.alice, { userId: P.bob.userId })
    const [talked] = await deps.db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, opened.conversation.id), eq(messages.kind, 'user')))
      .limit(1)
    if (talked) {
      result.conversationsPresent += 1
    } else {
      result.conversationsCreated += 1
      await play(opened.conversation.id, DIRECT)
    }
  })
  return result
}

/** Creates the channel unless one of that name exists; says which. Content is only written into a new one. */
async function ensureChannel(
  deps: Deps,
  timed: Deps,
  owner: SessionPrincipal,
  begin: (script: Line[]) => void,
  script: Line[],
  input: { name: string; description: string },
): Promise<{ id: string; created: boolean }> {
  const [existing] = await deps.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.kind, 'channel'), eq(conversations.name, input.name)))
  if (existing) return { id: existing.id, created: false }
  begin(script)
  const made = await createConversation(
    timed,
    owner,
    { kind: 'channel', ...input },
    crypto.randomUUID(),
  )
  return { id: made.conversation.id, created: true }
}
