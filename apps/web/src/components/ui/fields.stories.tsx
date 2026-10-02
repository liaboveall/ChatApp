import type { Meta, StoryObj } from '@storybook/react-vite'
import { PasswordField, TextField } from './fields.tsx'

const meta = {
  title: 'Basics/Fields',
  component: TextField,
  tags: ['visual'],
  args: { label: '邮箱' },
} satisfies Meta<typeof TextField>
export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  render: () => (
    <div className="grid w-[380px] gap-4">
      <TextField label="默认" placeholder="name@example.com" />
      <TextField label="带提示" hint="3–20 位小写字母、数字、下划线。" defaultValue="alice" />
      <TextField label="出错" error="请输入完整的邮箱地址。" defaultValue="alice@" />
      <TextField label="校验通过" ok="邀请码有效。" defaultValue="C4XQ-9T2M-K7RA-2LPD" />
      <TextField label="禁用" disabled defaultValue="alice@example.test" />
      <TextField label="大号（登录页）" size="lg" placeholder="name@example.com" />
      <PasswordField
        label="密码"
        showLabel="显示密码"
        hideLabelText="隐藏密码"
        defaultValue="correct horse battery"
      />
    </div>
  ),
}

export const LongContent: Story = {
  render: () => (
    <div className="w-[260px]">
      <TextField
        label="很长的显示名也不能把布局撑破"
        defaultValue="Wolfeschlegelsteinhausenbergerdorff 周屿周屿周屿周屿周屿周屿周屿周屿周屿"
        hint="1–32 个字符，可以重复，支持中文和 emoji。"
      />
    </div>
  ),
}
