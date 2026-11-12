import { SITE_LIMIT_DEFAULTS } from '@chatapp/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { queryKeys } from '@/lib/queries.ts'
import { sampleMe } from '../../../.storybook/mock-api.ts'
import { clearSeed, seedUsers } from '../../../.storybook/sync-seed.ts'
import { AdminPage, type AdminSection } from './admin-page.tsx'

const id = (n: number) => `0198d0c0-0000-7000-8000-${String(n).padStart(12, '0')}`
const member = (
  n: number,
  name: string,
  username: string,
  over: { role?: 'user' | 'admin'; banned?: boolean; emailVerified?: boolean } = {},
) => ({
  id: id(n),
  username,
  name,
  email: `${username}@example.test`,
  role: over.role ?? 'user',
  banned: over.banned ?? false,
  banReason: over.banned ? '多次发送垃圾信息' : null,
  emailVerified: over.emailVerified ?? true,
  active: true,
  inviteQuota: 5,
  invitesUsed: 1,
  storageUsedBytes: 0,
  storageReservedBytes: 0,
  storageQuotaBytes: null,
  aiDailyTokens: null,
  meVersion: 2,
  createdAt: '2026-10-01T08:00:00.000Z',
})

/** The site administrator's page (M7): what is listed, how a state shows on a row, and the limits under their headings. */
const meta = {
  title: 'Pages/Site administration',
  tags: ['visual'],
  parameters: {
    layout: 'fullscreen',
    api: {
      '/api/admin/users': {
        body: {
          users: [
            member(201, 'Alice Chen', 'alice', { role: 'admin' }),
            member(202, '林博', 'bob'),
            member(203, '周屿', 'zhouyu', { emailVerified: false }),
            member(204, '广告账号', 'promo_2026', { banned: true }),
          ],
          nextCursor: null,
        },
      },
      '/api/admin/reports': {
        body: {
          reports: [
            {
              id: id(301),
              reporterName: '林博',
              reason: 'spam',
              details: '同一条推广链接在三个频道里各发了一遍。',
              status: 'open',
              resolutionNote: null,
              version: 1,
              createdAt: '2026-10-04T09:20:00.000Z',
            },
            {
              id: id(302),
              reporterName: '苏晴',
              reason: 'abuse',
              details: null,
              status: 'resolved',
              resolutionNote: '已核实并联系成员',
              version: 2,
              createdAt: '2026-10-02T15:05:00.000Z',
            },
          ],
          nextCursor: null,
        },
      },
      '/api/admin/invites': { body: { invites: [], nextCursor: null } },
      '/api/admin/settings': {
        body: {
          version: 3,
          policy: {
            runContentDays: 7,
            userDailyTokens: 500000,
            monthlyMicroUsd: 20_000_000,
            aiPaused: false,
            limits: SITE_LIMIT_DEFAULTS,
          },
          provider: 'soclaas',
          fastModel: 'x-test-1',
          deepModel: 'x-test-1',
          storageBudgetBytes: 50 * 1073741824,
        },
      },
    },
  },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

function Stage({ section }: { section: AdminSection }) {
  const client = useQueryClient()
  useState(() => {
    seedUsers(client, [])
    client.setQueryData(queryKeys.me, { ...sampleMe, role: 'admin' })
  })
  useEffect(() => clearSeed, [])
  return (
    <div style={{ height: 720, background: 'var(--bg-content)' }}>
      <AdminPage initialSection={section} />
    </div>
  )
}
const page = (section: AdminSection): Story => ({ render: () => <Stage section={section} /> })

/** Roles and states are tags: the administrator, the unverified address and the banned account stand out of the list. */
export const Members = page('users')
/** What the reporter wrote reads as text; an open report carries the accent, a closed one does not. */
export const Reports = page('reports')
/** Nothing to list: the empty state, not a line of text in a corner. */
export const NoInvitations = page('invites')
/** Twenty limits under four headings, two to a line. */
export const SiteSettings = page('policy')
