import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect } from 'react'
import { ISO, makeConversation, makeMe, makeMessage, makeUser, uuid } from '@/lib/sync/fixtures.ts'
import { previewOf } from '@/lib/sync/merge.ts'
import { usePresence } from '@/lib/sync/presence.ts'
import { SidebarItem } from './sidebar-item.tsx'

const meta = {
  title: 'Conversations/Sidebar rows',
  tags: ['visual'],
  parameters: { layout: 'padded', surface: 'wallpaper' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const ME = uuid(1)
const users = {
  [uuid(2)]: makeUser(2, { displayName: 'Bob Lin' }),
  [uuid(3)]: makeUser(3, { displayName: '周屿' }),
  [uuid(4)]: makeUser(4, { displayName: '助手', isBot: true }),
}
const preview = (senderId: string, text: string) => ({
  senderId,
  text,
  kind: 'user' as const,
  state: 'ok' as const,
})
const noop = () => {}

function Row({
  conversation,
  unread = 0,
}: {
  conversation: ReturnType<typeof makeConversation>
  unread?: number
}) {
  return (
    <SidebarItem
      conversation={conversation}
      unread={unread}
      previewHidden={false}
      users={users}
      meId={ME}
      tabStop={false}
      onFocus={noop}
      onMenu={noop}
    />
  )
}

export const Rows: Story = {
  render: () => {
    // The status dot of the direct message is the presence of the other person.
    useEffect(() => {
      usePresence.setState({
        byUser: { [uuid(2)]: { userId: uuid(2), status: 'online', lastSeenAt: null } },
      })
    }, [])
    return (
      // The rows are laid out by the width of the window around them (`win`, shell.css): the sidebar is only this wide
      // here, so the window is the wide one that the app has on a desktop.
      <div style={{ containerType: 'inline-size', containerName: 'win', width: 1100 }}>
        <div
          className="sidebar glass squircle"
          style={{ width: 300, height: 'auto', padding: 8, position: 'relative' }}
        >
          <ul className="s-list">
            <li>
              <Row
                unread={3}
                conversation={makeConversation(10, {
                  name: '产品讨论',
                  lastMessageAt: ISO,
                  lastMessagePreview: preview(uuid(2), '明天上午十点开会，记得带上数据'),
                })}
              />
            </li>
            <li>
              <Row
                conversation={makeConversation(11, {
                  kind: 'channel',
                  name: '综合讨论',
                  lastMessageAt: ISO,
                  lastMessagePreview: preview(ME, '好的，我晚点回复你'),
                  me: makeMe({ pinnedAt: ISO }),
                })}
              />
            </li>
            <li>
              <Row
                unread={120}
                conversation={makeConversation(12, {
                  kind: 'channel',
                  name: '一个名字特别特别长的频道，看看省略号是不是显示得对',
                  lastMessageAt: ISO,
                  lastMessagePreview: preview(
                    uuid(3),
                    '这是一条很长很长的预览文字，用来检查省略号',
                  ),
                  me: makeMe({ mute: { mode: 'forever' } }),
                })}
              />
            </li>
            <li>
              <Row
                unread={1}
                conversation={makeConversation(13, {
                  kind: 'dm',
                  name: null,
                  dmPeer: users[uuid(2)] ?? null,
                  lastMessageAt: ISO,
                  lastMessagePreview: preview(uuid(2), '在吗？'),
                })}
              />
            </li>
            <li>
              <Row
                conversation={makeConversation(14, {
                  name: '周末爬山',
                  lastMessageAt: ISO,
                  lastMessagePreview: {
                    senderId: uuid(3),
                    text: null,
                    kind: 'user',
                    state: 'recalled',
                  },
                })}
              />
            </li>
          </ul>
        </div>
      </div>
    )
  },
}

export const MarkdownPreviews: Story = {
  render: () => (
    <div style={{ containerType: 'inline-size', containerName: 'win', width: 1100 }}>
      <div
        className="sidebar glass squircle"
        style={{ width: 300, height: 'auto', padding: 8, position: 'relative' }}
      >
        <ul className="s-list">
          {[
            ['综合讨论', '**当前会话总结**\n\n- **时间**：明天八点\n- **地点**：地铁站'],
            ['周末爬山', '# **周六爬山计划总结**\n\n1. 八点集合\n2. 准备饮水'],
            ['路线与装备', '查看[**路线图**](https://example.com/map)，带好**饮水**和*外套*'],
          ].map(([name, body], index) => (
            <li key={name}>
              <Row
                conversation={makeConversation(20 + index, {
                  kind: index === 0 ? 'channel' : 'group',
                  name: name ?? '',
                  lastMessageAt: ISO,
                  lastMessagePreview: previewOf(
                    makeMessage(index + 1, { kind: 'agent', senderId: uuid(4), body: body ?? '' }),
                  ),
                  me: makeMe({ pinnedAt: index === 0 ? ISO : null }),
                })}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  ),
}
