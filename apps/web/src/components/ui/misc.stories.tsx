import type { Meta, StoryObj } from '@storybook/react-vite'
import { Copy, LogOut, MessagesSquare, Pencil, Settings, WifiOff } from 'lucide-react'
import { Avatar } from './avatar.tsx'
import { Badge } from './badge.tsx'
import { Button, IconButton } from './button.tsx'
import { Dialog } from './dialog.tsx'
import { Banner, EmptyState, Skeleton, Spinner } from './feedback.tsx'
import { Menu, MenuGroup, MenuItem } from './menu.tsx'
import { Tooltip } from './tooltip.tsx'

const meta = {
  title: 'Basics/Display and overlays',
  tags: ['visual'],
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const AvatarsAndBadges: Story = {
  render: () => (
    <div className="grid gap-4">
      <div className="flex items-center gap-4">
        <Avatar name="Alice Chen" seed="alice" status="online" statusLabel="在线" />
        <Avatar name="Bob Lin" seed="bob" status="away" statusLabel="离开" />
        <Avatar name="周屿" seed="zhouyu" status="offline" statusLabel="离线" />
        <Avatar name="助手" seed="bot" bot />
        <Avatar name="Large" seed="large" size={56} />
      </div>
      <div className="flex items-center gap-3">
        <Badge>3</Badge>
        <Badge>99+</Badge>
        <Badge tone="muted">12</Badge>
        <Badge tone="danger">2</Badge>
        <Badge tone="role">此设备</Badge>
      </div>
    </div>
  ),
}

export const Feedback: Story = {
  render: () => (
    <div className="grid w-[460px] gap-3">
      <Banner tone="info">本地开发时邮件在 Mailpit 里。</Banner>
      <Banner tone="warning">修改后，其他设备的登录会话会全部注销。</Banner>
      <Banner tone="danger">邮箱或密码不对。连续输错会被暂时限制。</Banner>
      <Banner tone="success">邮箱已验证。</Banner>
      <div className="flex items-center gap-3">
        <Skeleton width={38} height={38} />
        <div className="grid gap-2">
          <Skeleton width={200} height={14} />
          <Skeleton width={120} height={12} />
        </div>
        <Spinner label="正在加载" />
      </div>
    </div>
  ),
}

export const EmptyAndError: Story = {
  render: () => (
    <div className="grid w-[420px] gap-4">
      <EmptyState icon={MessagesSquare} title="还没有会话">
        聊天功能正在开发中，敬请期待。
      </EmptyState>
      <EmptyState
        icon={WifiOff}
        title="连不上服务器"
        error
        action={<Button kind="tinted">重试</Button>}
      >
        请检查网络后重试。
      </EmptyState>
    </div>
  ),
}

export const OpenMenu: Story = {
  parameters: { surface: 'wallpaper' },
  render: () => (
    <div className="min-h-[240px]">
      <Menu defaultOpen trigger={<IconButton label="更多" icon={Settings} tooltip={false} />}>
        <MenuGroup>
          <MenuItem icon={Pencil} hint="⌘ ,">
            设置
          </MenuItem>
          <MenuItem icon={Copy}>复制链接</MenuItem>
        </MenuGroup>
        <MenuGroup>
          <MenuItem icon={LogOut} danger>
            退出登录
          </MenuItem>
          <MenuItem disabled>已禁用</MenuItem>
        </MenuGroup>
      </Menu>
    </div>
  ),
}

export const OpenTooltip: Story = {
  render: () => (
    <div className="min-h-[100px] pt-2">
      <Tooltip content="命令面板" shortcut={['mod', 'K']} defaultOpen side="bottom">
        <IconButton label="命令面板" icon={Settings} tooltip={false} />
      </Tooltip>
    </div>
  ),
}

export const ConfirmDialog: Story = {
  parameters: { layout: 'fullscreen', surface: 'wallpaper' },
  render: () => (
    <Dialog
      open
      onOpenChange={() => {}}
      title="注销“Chrome · Windows”？"
      description="这些设备会被立即断开，需要重新登录。"
      actions={
        <>
          <Button kind="plain">取消</Button>
          <Button danger>注销</Button>
        </>
      }
    >
      <Banner tone="warning">由这些设备发起、还没完成的助手任务和提醒会被取消。</Banner>
    </Dialog>
  ),
}
