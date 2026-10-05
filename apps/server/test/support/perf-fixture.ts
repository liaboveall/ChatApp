/**
 * The ten-thousand-message conversation of the performance tests (docs/12 D-149). `generatePerfMessages` is a pure
 * function of a fixed seed: the same words, senders, replies and gaps every time, only the clock they hang on differs.
 * `buildPerfFixture` creates the people and the group through the domain (so the conversation, its members and its
 * system lines are what the application makes) and then writes the messages straight into the tables, the way
 * `seedMessages` does, because the API's send limits make ten thousand messages by request take hours.
 *
 * Two rules are fixed on purpose, because the tests measure against them: the last message (seq 10,000) replies to seq
 * 3,000, and the last hundred (seq 9,901 to 10,000) are written by perf_a and perf_c only, with perf_b's read position at
 * 9,900 — so opening the group as perf_b lands on a known "new messages" line with a known unread count of 100.
 */
import { conversationChanges, conversationMembers, conversations, messages } from '@chatapp/db'
import { and, eq, inArray } from 'drizzle-orm'
import { createConversation } from '../../src/domain/conversations.ts'
import type { Deps } from '../../src/domain/deps.ts'
import { createActiveUser, makePrincipal } from './deps.ts'

export const PERF = {
  groupName: '性能 10k',
  /** The sequence number of the newest message. */
  lastSeq: 10_000,
  /** Seq 10,000 replies to seq 3,000. */
  replyFrom: 10_000,
  replyTo: 3_000,
  /** From here on only perf_a and perf_c write. */
  tailFrom: 9_901,
  /** perf_b has read up to here. */
  readPosition: 9_900,
  usernames: { a: 'perf_a', b: 'perf_b', c: 'perf_c' },
  seed: 20_261_004,
  /** The time span the conversation covers, ending a few minutes before "now". */
  spanMs: 30 * 86_400_000,
  endsBeforeNowMs: 10 * 60_000,
} as const

export type PerfWho = 'a' | 'b' | 'c'

export type PerfMessage = {
  seq: number
  who: PerfWho
  body: string
  /** Milliseconds after the first message. */
  offsetMs: number
  replyToSeq: number | null
}

// ───────── The words ─────────

const ZH = [
  '今天的进度怎么样了',
  '我先把方案整理一下，下午发给大家',
  '这个问题我复现了，是边界条件没处理',
  '明天上午十点开会，记得带上数据',
  '收到，马上处理',
  '有没有人看过上周的报告？',
  '数据对不上，再核对一下第三列',
  '午饭吃什么？楼下新开了一家面馆',
  '周末一起去爬山吧，天气应该不错',
  '这条先放一放，等需求确认了再说',
  '我觉得可以拆成两个小任务',
  '测试环境又挂了，谁在用？',
  '刚才的链接打不开，能再发一次吗',
  '好的，我晚点回复你',
  '辛苦了，今天先到这里',
  '这个按钮的位置是不是太靠边了',
  '文案改好了，麻烦再过一遍',
  '我在路上，大概二十分钟到',
  '昨天的版本已经发布了',
  '谢谢提醒，我这就去看',
]
const EN = [
  'sounds good to me',
  'let me check the logs first',
  'I pushed a fix, please take a look',
  'the build is green again',
  'can we move this to tomorrow?',
  'thanks, that helps a lot',
  'looks right, merging now',
  'I will write it up and share the notes',
  'not sure yet, need another look',
  'the numbers match after the second run',
  'who owns the deployment this week?',
  'quick question about the schedule',
]
const MIXED = [
  '这个 bug 在 staging 上也能复现',
  '部署到 production 之前先跑一遍 e2e',
  '我把 PR 合并了，CI 还在跑',
  'review 一下这个 diff，改动不大',
  '周报里的 KPI 数字是 final 的吗',
  'API 返回的 JSON 少了一个字段',
]
const LIST_ITEMS = [
  '准备材料',
  '确认时间',
  '通知相关同事',
  '整理会议纪要',
  'update the docs',
  'check the numbers',
]
const CODE = [
  '```ts\nconst total = items.reduce((sum, item) => sum + item.price, 0)\nconsole.log(total)\n```',
  '```bash\nbun run check && bun run test\n```',
  '```json\n{ "ok": true, "count": 3, "name": "测试" }\n```',
  '```sql\nselect id, name from users where deleted_at is null order by name;\n```',
]
const LINKS = [
  'https://example.test/docs/getting-started',
  'https://example.test/issues/1234',
  'https://example.test/wiki/周报',
  'https://example.test/files/report.pdf',
]
const LINK_TEXTS = ['文档', '这个工单', 'the dashboard', '周报模板']

// ───────── Generation ─────────

/** A small deterministic generator (mulberry32): the same seed gives the same sequence in every JavaScript engine. */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/**
 * The messages from `firstSeq` to `PERF.lastSeq`, in order. Pure: only the seed decides what is in them.
 * Mix (docs/12 D-149): one to six lines of Chinese and English; 10% with a list, 5% with a code block, 10% with a link,
 * 3% replies, 1% long ones; senders in runs of one to six; gaps that now and then pass an hour.
 */
export function generatePerfMessages(firstSeq = 1): PerfMessage[] {
  const random = generator(PERF.seed)
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T
  const sentence = (): string => {
    const r = random()
    return r < 0.5 ? pick(ZH) : r < 0.8 ? pick(EN) : pick(MIXED)
  }

  const result: PerfMessage[] = []
  let who: PerfWho = 'a'
  let run = 0
  const rawGaps: number[] = []
  for (let seq = firstSeq; seq <= PERF.lastSeq; seq += 1) {
    // Sender: runs of one to six messages, then somebody else; the tail has no perf_b.
    if (run === 0 || (seq >= PERF.tailFrom && who === 'b')) {
      const options = (['a', 'b', 'c'] as const).filter(
        (candidate) => candidate !== who && !(seq >= PERF.tailFrom && candidate === 'b'),
      )
      who = options[Math.floor(random() * options.length)] ?? 'a'
      run = 1 + Math.floor(random() * 6)
    }
    run -= 1

    // Body.
    let body: string
    if (random() < 0.01) {
      const parts: string[] = []
      while (parts.join('，').length < 1_500) parts.push(sentence())
      body = `${parts.join('，')}。`
    } else {
      const lines = Array.from({ length: 1 + Math.floor(random() * 6) }, sentence)
      if (random() < 0.1) {
        const count = 3 + Math.floor(random() * 3)
        lines.push(
          Array.from(
            { length: count },
            (_, i) => `- ${LIST_ITEMS[(seq + i) % LIST_ITEMS.length]}`,
          ).join('\n'),
        )
      }
      if (random() < 0.05) lines.push(pick(CODE))
      if (random() < 0.1) {
        lines.push(random() < 0.5 ? pick(LINKS) : `[${pick(LINK_TEXTS)}](${pick(LINKS)})`)
      }
      body = lines.join('\n')
    }

    // Replies: 3% quote an earlier message; the last one is fixed.
    const earliest = firstSeq
    const replyToSeq =
      seq === PERF.replyFrom
        ? PERF.replyTo
        : seq > earliest && random() < 0.03
          ? earliest + Math.floor(random() * (seq - earliest))
          : null

    // The gap before this message.
    const g = random()
    rawGaps.push(
      seq === firstSeq
        ? 0
        : g < 0.9
          ? 2_000 + random() * 58_000
          : g < 0.98
            ? 60_000 + random() * 840_000
            : 3_600_000 + random() * 7_200_000,
    )
    result.push({ seq, who, body, offsetMs: 0, replyToSeq })
  }

  // The gaps are scaled so that the conversation spans exactly the time it should, whatever the draw was.
  const total = rawGaps.reduce((sum, gap) => sum + gap, 0)
  const factor = (PERF.spanMs - PERF.endsBeforeNowMs) / total
  let at = 0
  result.forEach((message, index) => {
    at += (rawGaps[index] ?? 0) * factor
    message.offsetMs = Math.round(at)
  })
  return result
}

// ───────── The database ─────────

export type PerfPerson = { id: string; username: string; email: string; password: string }

export type PerfFixture = {
  conversationId: string
  people: Record<PerfWho, PerfPerson>
  /** The first seq the generator wrote (the group's own system lines come before it). */
  firstSeq: number
  /** The id of every generated message by seq. */
  idBySeq: Map<number, string>
}

const CHUNK = 500

/** Creates perf_a, perf_b and perf_c and the group "性能 10k" with its ten thousand messages. Uses the owner connection. */
export async function buildPerfFixture(deps: Deps): Promise<PerfFixture> {
  const create = async (who: PerfWho): Promise<PerfPerson> => {
    const username = PERF.usernames[who]
    return createActiveUser(deps, {
      username,
      email: `${username}@example.test`,
      password: `Zq9-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}-lantern`,
    })
  }
  const a = await create('a')
  const b = await create('b')
  const c = await create('c')

  const principal = await makePrincipal(deps, { id: a.id })
  const { conversation } = await createConversation(
    deps,
    principal,
    { kind: 'group', name: PERF.groupName, memberIds: [b.id, c.id] },
    crypto.randomUUID(),
  )
  const base = conversation.lastSeq
  const baseChange = conversation.lastChangeSeq
  const firstSeq = base + 1
  const generated = generatePerfMessages(firstSeq)

  const now = deps.clock.now().getTime()
  const start = now - PERF.spanMs
  const sender: Record<PerfWho, string> = { a: a.id, b: b.id, c: c.id }
  const ids = new Map<number, string>()
  for (const message of generated) ids.set(message.seq, deps.newId())

  const logTime = new Date(now)
  for (let from = 0; from < generated.length; from += CHUNK) {
    const part = generated.slice(from, from + CHUNK)
    await deps.db.insert(messages).values(
      part.map((message) => ({
        id: ids.get(message.seq) as string,
        conversationId: conversation.id,
        seq: message.seq,
        changeSeq: baseChange + (message.seq - base),
        senderId: sender[message.who],
        kind: 'user' as const,
        body: message.body,
        replyToId: message.replyToSeq === null ? null : (ids.get(message.replyToSeq) ?? null),
        executionSource: 'interactive' as const,
        createdAt: new Date(start + message.offsetMs),
      })),
    )
    await deps.db.insert(conversationChanges).values(
      part.map((message) => ({
        conversationId: conversation.id,
        changeSeq: baseChange + (message.seq - base),
        messageId: ids.get(message.seq) as string,
        kind: 'message_created' as const,
        createdAt: logTime,
      })),
    )
  }

  const last = generated[generated.length - 1]
  if (last === undefined) throw new Error('no messages were generated')
  await deps.db
    .update(conversations)
    .set({
      lastSeq: last.seq,
      lastChangeSeq: baseChange + (last.seq - base),
      lastMessageAt: new Date(start + last.offsetMs),
    })
    .where(eq(conversations.id, conversation.id))
  // Everybody has read to the end, except perf_b, who is at 9,900.
  await deps.db
    .update(conversationMembers)
    .set({ lastReadSeq: last.seq })
    .where(
      and(
        eq(conversationMembers.conversationId, conversation.id),
        inArray(conversationMembers.userId, [a.id, c.id]),
      ),
    )
  await deps.db
    .update(conversationMembers)
    .set({ lastReadSeq: PERF.readPosition })
    .where(
      and(
        eq(conversationMembers.conversationId, conversation.id),
        eq(conversationMembers.userId, b.id),
      ),
    )

  return { conversationId: conversation.id, people: { a, b, c }, firstSeq, idBySeq: ids }
}
