import type { Notification, NotificationPage } from '@chatapp/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { notices } from '@/lib/notifications/store.ts'
import { NotificationBell } from './notification-bell.tsx'

/**
 * The notification centre (docs/02 section 8, M6): the bell of the sidebar's user card and its panel, open. The panel reads
 * the first page when it opens, here from the story's mock answer.
 */

const id = (n: number): string => `0198d0c0-0000-7000-8000-${String(n).padStart(12, '0')}`

const person = (n: number, displayName: string, username: string) => ({
  id: id(n),
  profileVersion: 1,
  username,
  displayName,
  avatarUrl: null,
  isBot: false,
  deleted: false,
})

const group = { id: id(901), kind: 'group' as const, name: '产品设计组' }
const dm = { id: id(902), kind: 'dm' as const, name: null }

const ITEMS: Notification[] = [
  {
    id: id(1),
    version: 1,
    readAt: null,
    createdAt: '2026-10-04T11:52:00.000Z',
    type: 'mention',
    data: {
      available: true,
      conversation: group,
      message: {
        id: id(11),
        seq: 42,
        preview: '@Alice 下午三点的评审能把交互稿带上吗？',
        recalled: false,
      },
      sender: person(101, '周屿', 'zhouyu'),
    },
  },
  {
    id: id(2),
    version: 1,
    readAt: null,
    createdAt: '2026-10-04T11:30:00.000Z',
    type: 'approval_requested',
    data: {
      available: true,
      approval: {
        id: id(21),
        runId: id(22),
        status: 'pending',
        expiresAt: '2026-10-05T11:30:00.000Z',
      },
      conversationId: id(903),
    },
  },
  {
    id: id(3),
    version: 2,
    readAt: '2026-10-04T10:00:00.000Z',
    createdAt: '2026-10-04T09:40:00.000Z',
    type: 'reply',
    data: {
      available: true,
      conversation: dm,
      message: { id: id(31), seq: 7, preview: '好的，我晚上看一下。', recalled: false },
      sender: person(102, 'Carol Wu', 'carol_wu'),
    },
  },
  {
    id: id(4),
    version: 1,
    readAt: '2026-10-04T08:05:00.000Z',
    createdAt: '2026-10-04T08:00:00.000Z',
    type: 'reminder',
    data: {
      available: true,
      conversation: { id: id(904), kind: 'agent', name: '提醒' },
      message: { id: id(41), seq: 3, preview: '提交周报', recalled: false },
    },
  },
  {
    id: id(5),
    version: 2,
    readAt: '2026-10-03T20:00:00.000Z',
    createdAt: '2026-10-03T18:20:00.000Z',
    type: 'mention',
    data: {
      available: true,
      conversation: group,
      message: { id: id(51), seq: 30, preview: null, recalled: true },
      sender: person(103, 'Bob', 'bob'),
    },
  },
  {
    id: id(6),
    version: 1,
    readAt: '2026-10-03T12:00:00.000Z',
    createdAt: '2026-10-03T09:00:00.000Z',
    type: 'budget_alert',
    data: { period: '2026-10', percent: 80 },
  },
  {
    id: id(7),
    version: 3,
    readAt: '2026-10-02T12:00:00.000Z',
    createdAt: '2026-10-02T09:00:00.000Z',
    type: 'reply',
    data: { available: false },
  },
]

const page = (items: Notification[], unreadCount: number): NotificationPage => ({
  items,
  nextCursor: null,
  unreadCount,
})

const meta = {
  title: 'Notifications/Centre',
  tags: ['visual'],
  parameters: { layout: 'fullscreen', surface: 'wallpaper', surfaceHeight: 680 },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

/** The bell where the user card has it, at the bottom left, so the panel opens upwards as it does in the sidebar. */
function Stage() {
  // Each story starts from an empty centre: the panel's first read fills it.
  useState(() => notices.reset())
  return (
    <div style={{ height: 620, display: 'flex', alignItems: 'flex-end' }}>
      <NotificationBell onOpenSettings={() => {}} defaultOpen />
    </div>
  )
}

export const Entries: Story = {
  parameters: { api: { '/api/notifications': { body: page(ITEMS, 2) } } },
  render: () => <Stage />,
}

export const Empty: Story = {
  parameters: { api: { '/api/notifications': { body: page([], 0) } } },
  render: () => <Stage />,
}

export const CouldNotLoad: Story = {
  parameters: {
    api: {
      '/api/notifications': {
        status: 503,
        body: { error: { code: 'CAPACITY_UNAVAILABLE', message: 'busy', requestId: 'mock' } },
      },
    },
  },
  render: () => <Stage />,
}
