import type { Meta, StoryObj } from '@storybook/react-vite'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { sampleMe } from '../../../.storybook/mock-api.ts'
import { clearSeed, seedUsers, storyScope } from '../../../.storybook/sync-seed.ts'
import { type SettingsSection, SettingsSheet } from './settings-sheet.tsx'

const meta = {
  title: 'Pages/Settings',
  tags: ['visual'],
  parameters: {
    layout: 'fullscreen',
    surface: 'wallpaper',
    api: {
      '/api/me/devices': {
        body: {
          devices: [
            {
              id: '0198d0c0-0000-7000-8000-0000000000a1',
              current: true,
              createdAt: '2026-10-02T08:00:00.000Z',
              lastActiveAt: '2026-10-03T02:10:00.000Z',
              ipAddress: '192.0.2.10',
              userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36',
            },
            {
              id: '0198d0c0-0000-7000-8000-0000000000a2',
              current: false,
              createdAt: '2026-10-01T08:00:00.000Z',
              lastActiveAt: '2026-10-02T21:30:00.000Z',
              ipAddress: '198.51.100.7',
              userAgent:
                'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
            },
          ],
        },
      },
      '/api/auth/passkey/list-user-passkeys': {
        body: [{ id: 'pk-1', name: 'Chrome · Windows', createdAt: '2026-10-01T09:00:00.000Z' }],
      },
      '/api/invites': {
        body: {
          invites: [
            {
              id: '0198d0c0-0000-7000-8000-0000000000b1',
              note: '给周屿',
              maxUses: 1,
              useCount: 0,
              expiresAt: '2026-10-09T00:00:00.000Z',
              revokedAt: null,
              createdAt: '2026-10-02T00:00:00.000Z',
            },
            {
              id: '0198d0c0-0000-7000-8000-0000000000b2',
              note: null,
              maxUses: 3,
              useCount: 3,
              expiresAt: '2026-10-20T00:00:00.000Z',
              revokedAt: null,
              createdAt: '2026-09-28T00:00:00.000Z',
            },
          ],
          registrations: [
            {
              id: '0198d0c0-0000-7000-8000-0000000000c1',
              inviteId: '0198d0c0-0000-7000-8000-0000000000b2',
              status: 'account_created',
              username: 'carol_wu',
              createdAt: '2026-10-02T20:00:00.000Z',
            },
          ],
        },
      },
    },
  },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

function Stage({ section }: { section: SettingsSection }) {
  const client = useQueryClient()
  useState(() => {
    seedUsers(client, [])
    client.setQueryData(['agent-usage', storyScope.userId, storyScope.generation], {
      provider: 'soclaas',
      day: '2026-10-04',
      month: '2026-10',
      warning: false,
      paused: false,
      daily: {
        limit: 500000,
        settled: 42000,
        reserved: 12000,
        unknown: 0,
        available: 446000,
        resetAt: '2026-10-04T16:00:00.000Z',
      },
      monthly: {
        limitMicroUsd: 0,
        settledMicroUsd: 0,
        reservedMicroUsd: 0,
        unknownMicroUsd: 0,
        availableMicroUsd: 0,
        resetAt: '2026-10-31T16:00:00.000Z',
      },
    })
  })
  useEffect(() => clearSeed, [])
  return (
    <div style={{ height: 700 }}>
      <SettingsSheet
        section={section}
        me={sampleMe as never}
        onClose={() => {}}
        onSignOut={() => {}}
      />
    </div>
  )
}
const sheet = (section: SettingsSection): Story => ({ render: () => <Stage section={section} /> })

export const Appearance = sheet('appearance')
export const Account = sheet('account')
export const Invitations = sheet('invites')
