import type { Meta, StoryObj } from '@storybook/react-vite'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { endCompose, startEdit, startReply } from '@/lib/sync/compose.ts'
import { setDraft } from '@/lib/sync/drafts.ts'
import { makeConversation, makeMe, makeMessage, makeUser, uuid } from '@/lib/sync/fixtures.ts'
import { sampleMe } from '../../../.storybook/mock-api.ts'
import { clearSeed, seedUsers } from '../../../.storybook/sync-seed.ts'
import { Composer } from './composer.tsx'

const meta = {
  title: 'Composer/States',
  tags: ['visual'],
  parameters: {
    layout: 'padded',
    surface: 'wallpaper',
    api: { 'GET /api/me': { body: sampleMe } },
  },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const handle = { current: null }
const note = makeMessage(7, {
  senderId: uuid(2),
  body: '明天上午十点开会，记得带上数据',
})
const mine = makeMessage(8, { senderId: sampleMe.id, body: '我把方案整理了一下' })

function Stage({
  draft = '',
  mode,
  conversation = makeConversation(1, { name: '产品讨论', kind: 'group' }),
}: {
  draft?: string
  mode?: 'reply' | 'edit'
  conversation?: ReturnType<typeof makeConversation>
}) {
  // The person being replied to is in the dictionary, as in the app, so the bar names them.
  const client = useQueryClient()
  useState(() => seedUsers(client, [makeUser(2, { displayName: 'Bob Lin' })]))
  useEffect(() => clearSeed, [])
  useEffect(() => {
    const membershipId = conversation.me?.membershipId ?? uuid(700)
    endCompose(conversation.id, membershipId)
    setDraft(conversation.id, draft)
    if (mode === 'reply') startReply(conversation.id, membershipId, note)
    if (mode === 'edit') startEdit(conversation.id, membershipId, mine, '')
    if (mode === 'edit') setDraft(conversation.id, mine.body ?? '')
    return () => {
      endCompose(conversation.id, membershipId)
      setDraft(conversation.id, '')
    }
  }, [conversation.id, conversation.me?.membershipId, draft, mode])
  return (
    <div className="convo" style={{ position: 'relative', width: 760, height: 150, inset: 'auto' }}>
      <div className="composer-dock" style={{ position: 'absolute', bottom: 0 }}>
        <Composer conversation={conversation} timeline={handle} />
      </div>
    </div>
  )
}

export const Empty: Story = { render: () => <Stage /> }
export const Typing: Story = { render: () => <Stage draft="明天见，别忘了带电脑" /> }
export const ManyLines: Story = {
  render: () => <Stage draft={'第一行\n第二行\n第三行\n第四行\n第五行'} />,
}
export const Replying: Story = { render: () => <Stage mode="reply" draft="好的" /> }
export const Editing: Story = { render: () => <Stage mode="edit" /> }
export const Archived: Story = {
  render: () => (
    <Stage
      conversation={makeConversation(2, { name: '旧项目', archivedAt: '2026-10-01T00:00:00.000Z' })}
    />
  ),
}
export const Silenced: Story = {
  render: () => (
    <Stage
      conversation={makeConversation(3, {
        name: '产品讨论',
        me: makeMe({ silencedUntil: '2026-10-05T00:00:00.000Z' }),
      })}
    />
  ),
}
