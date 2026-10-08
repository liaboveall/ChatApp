import type { Message } from '@chatapp/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { loadMarkdown } from '@/components/markdown/lazy.ts'
import { makeMessage, makeUser, uuid } from '@/lib/sync/fixtures.ts'
import type { PendingMessage } from '@/lib/sync/outbox.ts'
import type { TimelineWindow } from '@/lib/sync/types.ts'
import { noActions } from '../message-actions/eligibility.ts'
import { buildItems, type TimelineItem } from './items.ts'
import { type RowContext, TimelineRow } from './message-row.tsx'

const meta = {
  title: 'Timeline/Rows',
  tags: ['visual'],
  parameters: { layout: 'padded', surface: 'plain' },
  // The Markdown renderer is its own chunk (D-145): wait for it, so the rows are drawn the way they are in the app.
  loaders: [async () => void (await loadMarkdown())],
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const ME = uuid(1)
const BOB = uuid(2)
const ZHOU = uuid(3)
const users = {
  [ME]: makeUser(1, { displayName: 'Alice Chen' }),
  [BOB]: makeUser(2, { displayName: 'Bob Lin' }),
  [ZHOU]: makeUser(3, { displayName: '周屿' }),
}
const noop = () => {}
const at = (day: string, time: string): string => `2026-10-${day}T${time}:00.000Z`

const context = (kind: 'group' | 'dm'): RowContext => ({
  positions: new Map(),
  setSize: -1,
  meId: ME,
  users,
  locale: 'zh-CN',
  timeZone: 'Asia/Shanghai',
  now: Date.parse('2026-10-04T12:00:00.000Z'),
  conversationName: '产品讨论',
  joinedAt: at('02', '01:30'),
  conversationKind: kind,
  currentId: null,
  freshIds: new Set(),
  onRetry: noop,
  onDiscard: noop,
  onJump: noop,
  onSelect: noop,
  flashId: null,
  actionsOf: () => noActions,
  onMenu: noop,
  onReply: noop,
})

const msg = (
  seq: number,
  sender: string | null,
  body: string | null,
  createdAt: string,
  patch: Partial<Message> = {},
) => makeMessage(seq, { senderId: sender, body, createdAt, ...patch })

const pending = (state: PendingMessage['state'], body: string): PendingMessage => ({
  clientId: uuid(900 + body.length),
  conversationId: uuid(500),
  membershipId: uuid(700),
  body,
  replyToId: null,
  quote: null,
  createdAt: at('04', '11:59'),
  state,
  error: state === 'failed' ? 'NETWORK' : null,
})

function Rows({
  messages,
  pendings = [],
  kind = 'group',
  anchor,
  hasMoreBefore = false,
  visibleFromSeq = 0,
}: {
  messages: Message[]
  pendings?: PendingMessage[]
  kind?: 'group' | 'dm'
  anchor?: number
  hasMoreBefore?: boolean
  visibleFromSeq?: number
}) {
  const window: TimelineWindow = {
    conversationId: uuid(500),
    membershipId: uuid(700),
    messages,
    hasMoreBefore,
    hasMoreAfter: false,
    hidden: {},
    gone: {},
    quoted: {},
    revision: 1,
  }
  const built = buildItems({
    window,
    pending: pendings,
    meId: ME,
    conversation: { kind, me: { visibleFromSeq } },
    anchor,
    timeZone: 'Asia/Shanghai',
  })
  const ctx = context(kind)
  const row = (item: TimelineItem) => (
    <div className="timeline__inner" key={item.key}>
      <TimelineRow item={item} context={ctx} />
    </div>
  )
  return <div style={{ width: 720 }}>{built.items.map(row)}</div>
}

export const Mentions: Story = {
  render: () => (
    <Rows
      messages={[
        msg(1, ME, `<@user:${BOB}> 请看一下周六的集合计划。`, at('04', '02:10'), {
          mentions: [BOB],
        }),
        msg(2, BOB, `<@user:${ME}> 收到，我会带两瓶水。`, at('04', '02:11'), { mentions: [ME] }),
      ]}
    />
  ),
}

export const Conversation: Story = {
  render: () => (
    <Rows
      anchor={3}
      visibleFromSeq={0}
      messages={[
        msg(1, BOB, '早上好，今天的进度怎么样了？', at('03', '01:00')),
        msg(2, BOB, '我把方案整理了一下：\n\n- 登录页\n- 会话列表\n- 输入栏', at('03', '01:01')),
        msg(3, ME, '收到，马上看。', at('03', '01:05')),
        msg(
          4,
          ZHOU,
          '这个 **bug** 在 `staging` 上也能复现，详见 [工单](https://example.test/issues/1234)',
          at('04', '02:10'),
        ),
        msg(
          5,
          ZHOU,
          '```ts\nconst total = items.reduce((sum, item) => sum + item.price, 0)\n```',
          at('04', '02:11'),
        ),
        msg(6, ME, '好的，我来处理。', at('04', '02:12'), {
          replyTo: {
            id: uuid(1004),
            seq: 4,
            senderId: ZHOU,
            excerpt: '这个 bug 在 staging 上也能复现',
            state: 'ok',
          },
        }),
        msg(7, ME, '改好了，麻烦再看一眼', at('04', '02:14'), { editedAt: at('04', '02:15') }),
        msg(8, BOB, null, at('04', '02:16'), { recalledAt: at('04', '02:17') }),
        msg(9, null, null, at('04', '02:20'), {
          kind: 'system',
          meta: { system: { type: 'member_joined', userId: BOB, addedBy: ZHOU } },
        }),
        msg(10, BOB, '谢谢大家', at('04', '02:21'), {
          replyTo: { id: uuid(1001), seq: 1, senderId: BOB, excerpt: null, state: 'recalled' },
        }),
      ]}
      pendings={[pending('sending', '正在发送的一条消息'), pending('failed', '这一条没有发出去')]}
    />
  ),
}

export const StartAndBoundary: Story = {
  render: () => (
    <div className="grid gap-6">
      <Rows messages={[msg(1, ME, '这是会话里的第一条消息', at('03', '01:00'))]} />
      <Rows
        visibleFromSeq={40}
        messages={[
          msg(41, BOB, '你加入之后的第一条消息', at('02', '01:40'), {
            replyTo: {
              id: uuid(1010),
              seq: 12,
              senderId: ZHOU,
              excerpt: null,
              state: 'ok',
            } as never,
          }),
        ]}
      />
      <Rows
        kind="dm"
        messages={[
          msg(1, BOB, '嗨，在吗？', at('03', '01:00')),
          msg(2, ME, '在的，怎么了？', at('03', '01:01')),
        ]}
      />
    </div>
  ),
}

export const LongAndMixed: Story = {
  render: () => (
    <Rows
      messages={[
        msg(
          1,
          ZHOU,
          '这是一段没有标点也没有空格的长消息用来检查文字在气泡里能不能自动换行而不撑破布局这是一段没有标点也没有空格的长消息用来检查文字在气泡里能不能自动换行而不撑破布局',
          at('04', '03:00'),
        ),
        msg(
          2,
          ME,
          'English works too: the quick brown fox jumps over the lazy dog, and then keeps running through the whole conversation.',
          at('04', '03:01'),
        ),
        msg(
          3,
          BOB,
          '有序列表：\n\n1. 第一步\n2. 第二步\n3. 第三步\n\n> 引用的一段话\n\n~~删除线~~ 和 *斜体*',
          at('04', '03:02'),
        ),
        msg(
          4,
          BOB,
          '<img src=x onerror="alert(1)"> <script>alert(1)</script> [点我](javascript:alert(1))',
          at('04', '03:03'),
        ),
      ]}
    />
  ),
}
