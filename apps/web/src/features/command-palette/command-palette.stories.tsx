import type { Meta, StoryObj } from '@storybook/react-vite'
import { Keyboard, Moon, Palette, Ticket, User } from 'lucide-react'
import { CommandPalette, type PaletteCommand } from './command-palette.tsx'

const meta = {
  title: 'Overlays/Command palette',
  tags: ['visual'],
  parameters: { layout: 'fullscreen', surface: 'wallpaper' },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

const run = () => {}
const commands: PaletteCommand[] = [
  { id: 'a', group: '跳转', icon: Palette, label: '打开外观设置', run },
  { id: 'b', group: '跳转', icon: User, label: '打开账号设置', run },
  { id: 'c', group: '跳转', icon: Ticket, label: '打开邀请设置', run },
  { id: 'd', group: '跳转', icon: Keyboard, label: '键盘快捷键', keys: ['mod', '/'], run },
  { id: 'e', group: '外观', icon: Moon, label: '切换到深色', run },
]

export const Open: Story = {
  render: () => (
    <div style={{ height: 620 }}>
      <CommandPalette open onOpenChange={() => {}} commands={commands} />
    </div>
  ),
}
