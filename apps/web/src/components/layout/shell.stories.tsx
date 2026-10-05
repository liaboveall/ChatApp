import type { Meta, StoryObj } from '@storybook/react-vite'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { AppIcon } from '@/components/brand/app-icon.tsx'
import { Welcome } from '@/features/shell/welcome.tsx'
import { type InspectorTab, useShell } from '@/lib/shell-state.ts'
import { ISO, makeConversation, makeMe, makeUser, uuid } from '@/lib/sync/fixtures.ts'
import { usePresence } from '@/lib/sync/presence.ts'
import type { ConversationIndex } from '@/lib/sync/types.ts'
import { sampleMe } from '../../../.storybook/mock-api.ts'
import { clearSeed, seedConversations, seedUsers } from '../../../.storybook/sync-seed.ts'
import { AppShell } from './app-shell.tsx'
import { Inspector } from './inspector.tsx'
import { Sidebar } from './sidebar.tsx'
import { Toolbar } from './toolbar.tsx'

const meta = {
  title: 'Layout/App shell',
  tags: ['visual'],
  parameters: { layout: 'fullscreen', surface: 'none' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const preview = (senderId: string, text: string) => ({
  senderId,
  text,
  kind: 'user' as const,
  state: 'ok' as const,
})

/** What the sidebar shows when the engine has loaded a person's conversations: a few of each kind, one pinned, some unread. */
function seedSidebar(client: QueryClient): void {
  const bob = makeUser(2, { displayName: 'Bob Lin' })
  const zhou = makeUser(3, { displayName: '周屿' })
  const conversations = [
    makeConversation(11, {
      kind: 'channel',
      name: '综合讨论',
      lastSeq: 80,
      lastMessageAt: ISO,
      lastMessagePreview: preview(sampleMe.id, '好的，我晚点回复你'),
      me: makeMe({ pinnedAt: ISO, lastReadSeq: 80 }),
    }),
    makeConversation(10, {
      name: '产品讨论',
      lastSeq: 120,
      lastMessageAt: ISO,
      lastMessagePreview: preview(zhou.id, '明天上午十点开会，记得带上数据'),
      me: makeMe({ lastReadSeq: 117 }),
    }),
    makeConversation(14, {
      name: '周末爬山',
      lastSeq: 30,
      lastMessageAt: ISO,
      lastMessagePreview: preview(bob.id, '路线我发在群里了'),
      me: makeMe({ lastReadSeq: 30 }),
    }),
    makeConversation(13, {
      kind: 'dm',
      name: null,
      dmPeer: bob,
      lastSeq: 9,
      lastMessageAt: ISO,
      lastMessagePreview: preview(bob.id, '在吗？'),
      me: makeMe({ lastReadSeq: 8 }),
    }),
  ]
  const index: ConversationIndex = {
    byId: Object.fromEntries(conversations.map((conversation) => [conversation.id, conversation])),
    removed: {},
    previewHidden: {},
  }
  seedUsers(client, [bob, zhou])
  seedConversations(client, index)
  usePresence.setState({
    byUser: { [uuid(2)]: { userId: uuid(2), status: 'online', lastSeenAt: null } },
  })
}

function Shell({ width, inspector }: { width: number | string; inspector: InspectorTab | null }) {
  const client = useQueryClient()
  useState(() => seedSidebar(client))
  // What the story put into the stores does not outlive it (Storybook keeps the page between stories).
  useEffect(
    () => () => {
      clearSeed()
      usePresence.setState({ byUser: {} })
    },
    [],
  )
  useEffect(() => {
    useShell.setState({ inspector, drawerOpen: false })
  }, [inspector])
  const noop = () => {}
  return (
    <div style={{ width, height: 760, position: 'relative' }}>
      <AppShell
        sidebar={
          <Sidebar me={sampleMe} onOpenPalette={noop} onOpenSettings={noop} onCreate={noop} />
        }
        toolbar={
          <Toolbar
            title="ChatApp"
            avatar={<AppIcon size={34} />}
            assistantOpen={inspector === 'assistant'}
            onToggleAssistant={noop}
            onOpenDrawer={noop}
            onOpenPalette={noop}
            onOpenSettings={noop}
            onOpenShortcuts={noop}
          />
        }
        inspector={<Inspector />}
      >
        <Welcome name={sampleMe.displayName} />
      </AppShell>
    </div>
  )
}

export const Desktop: Story = { render: () => <Shell width={1440} inspector={null} /> }
export const DockedAssistantPanel: Story = {
  render: () => <Shell width={1440} inspector="assistant" />,
}
export const InspectorFloatsOverContent: Story = {
  render: () => <Shell width={1100} inspector="details" />,
}
export const SidebarAsRail: Story = { render: () => <Shell width={900} inspector={null} /> }
export const SingleColumn: Story = { render: () => <Shell width={420} inspector={null} /> }
