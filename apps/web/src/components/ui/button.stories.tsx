import type { Meta, StoryObj } from '@storybook/react-vite'
import { Check, Plus, Search, Settings, Trash2 } from 'lucide-react'
import { Button, type ButtonKind, IconButton } from './button.tsx'

const meta = {
  title: 'Basics/Button',
  component: Button,
  tags: ['visual'],
  args: { children: '保存' },
} satisfies Meta<typeof Button>
export default meta
type Story = StoryObj<typeof meta>

const KINDS: ButtonKind[] = ['filled', 'tinted', 'plain', 'glass']

export const Kinds: Story = {
  parameters: { surface: 'wallpaper' },
  render: () => (
    <div className="grid w-[760px] gap-4">
      {KINDS.map((kind) => (
        <div key={kind} className="flex flex-wrap items-center gap-3">
          <Button kind={kind}>{kind}</Button>
          <Button kind={kind} icon={Plus}>
            With icon
          </Button>
          <Button kind={kind} size="sm">
            Small
          </Button>
          <Button kind={kind} size="lg">
            Large
          </Button>
          <Button kind={kind} danger>
            Danger
          </Button>
          <Button kind={kind} disabled>
            Disabled
          </Button>
          <Button kind={kind} busy>
            Busy
          </Button>
        </div>
      ))}
    </div>
  ),
}

export const Block: Story = {
  render: () => (
    <div className="grid w-[340px] gap-3">
      <Button size="lg" block>
        登录
      </Button>
      <Button size="lg" block kind="tinted" icon={Check}>
        使用 Passkey 登录
      </Button>
    </div>
  ),
}

export const IconButtons: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <IconButton label="搜索" icon={Search} tooltip={false} />
      <IconButton label="设置" icon={Settings} tooltip={false} aria-pressed />
      <IconButton label="删除" icon={Trash2} tooltip={false} disabled />
      <IconButton label="新建" icon={Plus} variant="filled" tooltip={false} />
      <IconButton label="新建" icon={Plus} variant="round" tooltip={false} />
      <IconButton label="新建" icon={Plus} variant="plate" tooltip={false} />
    </div>
  ),
}
