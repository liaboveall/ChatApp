import type { AgentMemory } from '@chatapp/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ISO, uuid } from '@/lib/sync/fixtures.ts'
import { clearSeed, seedUsers, storyScope } from '../../../.storybook/sync-seed.ts'
import { MemoriesGroup } from './memories-group.tsx'

const meta = {
  title: 'Assistant/Personal memories',
  tags: ['visual'],
  parameters: { layout: 'padded', surface: 'plain' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>
function Stage({ populated = false }: { populated?: boolean }) {
  const client = useQueryClient()
  useState(() => {
    seedUsers(client, [])
    const memories: AgentMemory[] = populated
      ? [
          {
            id: uuid(960),
            content: '我偏好无糖绿茶，下午开会请安排短休息。',
            source: 'user',
            privacyClass: 'byok_private',
            contentVersion: 1,
            createdByRunId: null,
            createdAt: ISO,
            deletedAt: null,
          },
          {
            id: uuid(961),
            content: '会议记录尽量使用中文，项目名称保持原文。',
            source: 'user',
            privacyClass: 'standard',
            contentVersion: 2,
            createdByRunId: null,
            createdAt: ISO,
            deletedAt: null,
          },
          {
            id: uuid(962),
            content: '这条来自私有助手，派生隐私禁止直接放开站点使用。',
            source: 'agent',
            privacyClass: 'byok_private',
            contentVersion: 1,
            createdByRunId: uuid(963),
            createdAt: ISO,
            deletedAt: null,
          },
        ]
      : []
    client.setQueryData(['memories', storyScope.userId, storyScope.generation], { memories })
  })
  useEffect(() => clearSeed, [])
  return (
    <div style={{ maxWidth: 680 }}>
      <MemoriesGroup />
    </div>
  )
}
export const PrivateDefault: Story = { render: () => <Stage /> }
export const ConsentAndDerivedPrivacy: Story = { render: () => <Stage populated /> }
