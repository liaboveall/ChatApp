import type { Meta, StoryObj } from '@storybook/react-vite'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { Checkbox, SegmentedControl, Slider, Switch } from './controls.tsx'

const meta = {
  title: 'Basics/Controls',
  component: Switch,
  tags: ['visual'],
} satisfies Meta<typeof Switch>
export default meta
type Story = StoryObj<typeof meta>

function Demo() {
  const [on, setOn] = useState(true)
  const [off, setOff] = useState(false)
  const [checked, setChecked] = useState(true)
  const [theme, setTheme] = useState('system')
  const [glass, setGlass] = useState('standard')
  const [size, setSize] = useState(1)
  return (
    <div className="grid w-[420px] gap-5">
      <div className="flex items-center gap-3">
        <Switch label="开" checked={on} onCheckedChange={setOn} />
        <Switch label="关" checked={off} onCheckedChange={setOff} />
        <Switch label="禁用" checked disabled onCheckedChange={() => {}} />
      </div>
      <div className="grid gap-1">
        <Checkbox checked={checked} onCheckedChange={setChecked}>
          选中的复选框
        </Checkbox>
        <Checkbox checked={false} onCheckedChange={() => {}}>
          未选中
        </Checkbox>
        <Checkbox checked disabled onCheckedChange={() => {}}>
          禁用
        </Checkbox>
      </div>
      <SegmentedControl
        label="外观模式"
        value={theme}
        onValueChange={setTheme}
        items={[
          { value: 'light', label: '浅色', icon: Sun },
          { value: 'dark', label: '深色', icon: Moon },
          { value: 'system', label: '跟随系统', icon: Monitor },
        ]}
      />
      <SegmentedControl
        label="透明度"
        value={glass}
        onValueChange={setGlass}
        block
        items={[
          { value: 'clear', label: '清透' },
          { value: 'standard', label: '标准' },
          { value: 'tinted', label: '着色' },
          { value: 'opaque', label: '不透明' },
        ]}
      />
      <Slider
        label="界面字号"
        min={-1}
        max={3}
        value={size}
        valueText={`${size} 档`}
        onValueChange={setSize}
      />
    </div>
  )
}

export const Overview: Story = {
  args: { checked: true, onCheckedChange: () => {} },
  render: () => <Demo />,
}
