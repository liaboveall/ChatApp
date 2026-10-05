import type { Conversation, ConversationInvite, Me, Member } from '@chatapp/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { makeConversation, makeMe, makeUser, uuid } from '@/lib/sync/fixtures.ts'
import { sampleMe } from '../../../.storybook/mock-api.ts'
import { AddMembersDialog } from './add-members-dialog.tsx'
import { ConversationDetails } from './details.tsx'
import { LeaveDialog } from './leave-dialog.tsx'
import { type MemberDialog, MemberDialogs } from './member-dialogs.tsx'

const meta = {
  title: 'Inspector/Details',
  tags: ['visual'],
  parameters: { layout: 'padded', surface: 'wallpaper' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const noop = () => {}
const ME = sampleMe.id
const person = (n: number, name: string, username = name.toLowerCase()) =>
  makeUser(n, { displayName: name, username })
const bob = person(2, 'Bob')
const zhou = person(3, '周屿', 'zhouyu')

const member = (
  user: ReturnType<typeof person>,
  role: Member['role'],
  silencedUntil: string | null = null,
): Member => ({
  user,
  membershipVersion: 4,
  role,
  membershipId: uuid(2000 + Number(user.id.slice(-3))),
  joinedAt: '2026-10-01T08:00:00.000Z',
  silencedUntil,
})
const me = (role: Member['role']) =>
  member({ ...makeUser(1), id: ME, displayName: sampleMe.displayName, username: 'alice' }, role)

const GROUP = 20
const groupId = uuid(GROUP)
const members = (mine: Member['role']): Member[] => [
  me(mine === 'owner' ? 'owner' : 'member'),
  ...(mine === 'owner'
    ? [member(bob, 'admin'), member(zhou, 'member', '2026-10-05T10:00:00.000Z')]
    : [member(bob, 'owner'), member(zhou, 'member')]),
]

const invite = (
  n: number,
  createdBy: string,
  maxUses: number | null,
  useCount: number,
): ConversationInvite => ({
  id: uuid(3000 + n),
  conversationId: groupId,
  createdBy,
  maxUses,
  useCount,
  expiresAt: '2026-10-11T08:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-10-04T08:00:00.000Z',
})

const api = (mine: Member['role']) => ({
  [`GET /api/conversations/${groupId}/members`]: {
    body: { members: members(mine), membershipVersion: 4, nextCursor: null },
  },
  [`GET /api/conversations/${groupId}/invites`]: {
    body: { invites: [invite(1, ME, null, 2), invite(2, bob.id, 5, 1)] },
  },
  [`GET /api/conversations/${groupId}/bans`]: {
    body: {
      bans: [
        {
          user: person(9, 'Mallory'),
          bannedBy: ME,
          reason: '反复发广告',
          createdAt: '2026-10-03T08:00:00.000Z',
        },
      ],
    },
  },
  [`GET /api/users/${bob.id}`]: {
    body: { ...bob, bio: '做产品，也写一点代码。', createdAt: '2026-09-20T08:00:00.000Z' },
  },
})

/** The visual test photographs the four panel stories in a frame this tall (`visual/stories.spec.ts`). */
const PANEL_HEIGHT = 1480
/** The surface under it: the panel and the padding of the wallpaper box. */
const SURFACE_HEIGHT = PANEL_HEIGHT + 48

const account = (role: Me['role'] = 'user'): Me => ({ ...sampleMe, role, settings: {} }) as Me

function Panel({
  conversation,
  siteRole = 'user',
}: {
  conversation: Conversation
  siteRole?: Me['role']
}) {
  return (
    // Tall enough for the whole panel: the picture is the regression baseline of every section of it.
    <div className="inspector squircle" style={{ width: 320, height: PANEL_HEIGHT }}>
      <div className="inspector__body scroll">
        <ConversationDetails conversation={conversation} me={account(siteRole)} />
      </div>
    </div>
  )
}

const group = (role: Member['role'] | null, patch: Partial<Conversation> = {}): Conversation =>
  makeConversation(GROUP, {
    kind: 'group',
    name: '产品讨论',
    description: '每周的需求评审和日常沟通，欢迎随时提问。',
    memberCount: 3,
    membershipVersion: 4,
    me: role === null ? null : makeMe({ role }),
    ...patch,
  })

export const OwnerOfAGroup: Story = {
  parameters: { api: api('owner'), surfaceHeight: SURFACE_HEIGHT },
  render: () => <Panel conversation={group('owner')} />,
}

export const PlainMemberOfAGroup: Story = {
  parameters: { api: api('member'), surfaceHeight: SURFACE_HEIGHT },
  render: () => (
    <Panel conversation={group('member', { settings: { whoCanInvite: 'admins_only' } })} />
  ),
}

export const SiteAdministratorOutsideAGroup: Story = {
  parameters: { api: api('owner'), surfaceHeight: SURFACE_HEIGHT },
  render: () => <Panel siteRole="admin" conversation={group(null)} />,
}

export const DirectMessage: Story = {
  parameters: { api: api('member'), surfaceHeight: SURFACE_HEIGHT },
  render: () => (
    <Panel
      conversation={makeConversation(21, {
        kind: 'dm',
        name: null,
        dmPeer: bob,
        memberCount: 2,
        me: makeMe({ pinnedAt: '2026-10-04T08:00:00.000Z' }),
      })}
    />
  ),
}

const dialogMember = member(zhou, 'member')

function Open({ which }: { which: MemberDialog['kind'] | 'add' | 'leave' }) {
  const conversation = group('owner')
  useEffect(() => undefined, [])
  const run = async () => true
  return (
    <>
      <Button>背景</Button>
      <AddMembersDialog
        conversation={conversation}
        open={which === 'add'}
        onOpenChange={noop}
        onDone={noop}
      />
      <MemberDialogs
        dialog={which === 'add' || which === 'leave' ? null : { kind: which, member: dialogMember }}
        conversation={conversation}
        run={run}
        onClose={noop}
      />
      {which === 'leave' ? (
        <LeaveDialog conversation={conversation} open onOpenChange={noop} />
      ) : null}
    </>
  )
}

export const AddMembers: Story = {
  parameters: { api: api('owner') },
  render: () => <Open which="add" />,
}
export const SilenceQuestion: Story = { render: () => <Open which="silence" /> }
export const BanQuestion: Story = { render: () => <Open which="ban" /> }
export const RemoveQuestion: Story = { render: () => <Open which="remove" /> }
export const HandOverQuestion: Story = { render: () => <Open which="transfer" /> }
export const LeaveQuestion: Story = { render: () => <Open which="leave" /> }
