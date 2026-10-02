import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Search } from 'lucide-react'
import { useState } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { Avatar, hueOf, initialOf } from './avatar.tsx'
import { Button, IconButton } from './button.tsx'
import { Checkbox, SegmentedControl, Slider, Switch } from './controls.tsx'
import { Dialog } from './dialog.tsx'
import { PasswordField, TextField } from './fields.tsx'
import { TooltipProvider } from './tooltip.tsx'

describe('Button', () => {
  test('a busy button announces it, stays focusable and ignores clicks', async () => {
    const onClick = vi.fn()
    render(
      <Button busy onClick={onClick}>
        保存
      </Button>,
    )
    const button = screen.getByRole('button', { name: '保存' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  test('a disabled button does not submit its form', async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" disabled>
          发送
        </Button>
      </form>,
    )
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(onSubmit).not.toHaveBeenCalled()
  })

  test('an enabled button calls its handler', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>好</Button>)
    await userEvent.click(screen.getByRole('button', { name: '好' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

describe('IconButton', () => {
  test('is named by its label and keeps the shortcut for assistive technology', () => {
    render(
      <TooltipProvider>
        <IconButton label="搜索" icon={Search} shortcut={['mod', 'K']} />
      </TooltipProvider>,
    )
    const button = screen.getByRole('button', { name: '搜索' })
    expect(button).toHaveAttribute('aria-keyshortcuts', 'mod+K')
  })
})

describe('TextField', () => {
  test('the label, the hint and the error are wired to the input', () => {
    const { rerender } = render(<TextField label="邮箱" hint="登录用" />)
    const input = screen.getByLabelText('邮箱')
    const message = document.getElementById(input.getAttribute('aria-describedby') ?? '')
    expect(message).toHaveTextContent('登录用')
    expect(input).not.toHaveAttribute('aria-invalid')

    rerender(<TextField label="邮箱" hint="登录用" error="请输入完整的邮箱地址。" />)
    expect(screen.getByLabelText('邮箱')).toHaveAttribute('aria-invalid', 'true')
    expect(message).toHaveTextContent('请输入完整的邮箱地址。')
    expect(message).not.toHaveTextContent('登录用')
    expect(message).toHaveAttribute('aria-live', 'polite')
  })
})

describe('PasswordField', () => {
  test('shows and hides the password, and says which it will do next', async () => {
    render(<PasswordField label="密码" showLabel="显示密码" hideLabelText="隐藏密码" />)
    const input = screen.getByLabelText('密码', { selector: 'input' })
    expect(input).toHaveAttribute('type', 'password')
    await userEvent.click(screen.getByRole('button', { name: '显示密码' }))
    expect(input).toHaveAttribute('type', 'text')
    await userEvent.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(input).toHaveAttribute('type', 'password')
  })
})

function Controlled() {
  const [mode, setMode] = useState<'light' | 'dark' | 'system'>('system')
  const [on, setOn] = useState(false)
  const [agreed, setAgreed] = useState(false)
  return (
    <>
      <SegmentedControl
        label="外观模式"
        value={mode}
        onValueChange={setMode}
        items={[
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
          { value: 'system', label: '跟随系统' },
        ]}
      />
      <output data-testid="mode">{mode}</output>
      <span id="sw">通知</span>
      <Switch labelledBy="sw" checked={on} onCheckedChange={setOn} />
      <Checkbox checked={agreed} onCheckedChange={setAgreed}>
        同意
      </Checkbox>
    </>
  )
}

describe('controls', () => {
  test('a segmented control is a radio group: the arrow keys move and select', async () => {
    render(<Controlled />)
    expect(screen.getByRole('radiogroup', { name: '外观模式' })).toBeInTheDocument()
    const system = screen.getByRole('radio', { name: '跟随系统' })
    expect(system).toBeChecked()
    system.focus()
    await userEvent.keyboard('{ArrowLeft}')
    expect(screen.getByTestId('mode')).toHaveTextContent('dark')
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: '浅色' }))
    expect(screen.getByTestId('mode')).toHaveTextContent('light')
  })

  test('a switch is a switch with the visible label as its name, and Space toggles it', async () => {
    render(<Controlled />)
    const toggle = screen.getByRole('switch', { name: '通知' })
    expect(toggle).not.toBeChecked()
    toggle.focus()
    await userEvent.keyboard(' ')
    expect(toggle).toBeChecked()
  })

  test('a checkbox is named by its label and toggles by clicking the label', async () => {
    render(<Controlled />)
    const box = screen.getByRole('checkbox', { name: '同意' })
    expect(box).not.toBeChecked()
    await userEvent.click(screen.getByText('同意'))
    expect(box).toBeChecked()
  })

  test('the slider reports its value as text', () => {
    render(
      <Slider label="字号" min={-1} max={3} value={2} valueText="+2 档" onValueChange={() => {}} />,
    )
    const slider = screen.getByRole('slider', { name: '字号' })
    expect(slider).toHaveAttribute('aria-valuetext', '+2 档')
    expect(slider).toHaveValue('2')
  })
})

describe('Avatar', () => {
  test('the same person always gets the same hue; the initial is the first character', () => {
    expect(hueOf('0198d0c0-aaaa')).toBe(hueOf('0198d0c0-aaaa'))
    expect(hueOf('a')).not.toBe(hueOf('b'))
    expect(initialOf('alice')).toBe('A')
    expect(initialOf('周屿')).toBe('周')
    expect(initialOf('👩‍💻 Dev')).toBe('👩‍💻')
    expect(initialOf('   ')).toBe('?')
  })

  test('presence is announced through its label, not only its shape', () => {
    render(<Avatar name="Alice" seed="1" status="away" statusLabel="离开" />)
    expect(screen.getByRole('img', { name: '离开' })).toHaveAttribute('data-status', 'away')
  })
})

describe('Dialog', () => {
  test('is a labelled modal dialog; Escape closes it', async () => {
    const onOpenChange = vi.fn()
    render(
      <Dialog open onOpenChange={onOpenChange} title="修改密码" description="其他设备会被注销">
        <input aria-label="当前密码" />
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog', { name: '修改密码' })
    expect(dialog).toHaveAccessibleDescription('其他设备会被注销')
    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything())
  })

  test('the page behind a modal is marked so the stylesheet can drop the toolbar blur', () => {
    const { unmount } = render(<Dialog open onOpenChange={() => {}} title="x" />)
    expect(document.documentElement).toHaveAttribute('data-modal', 'true')
    unmount()
    expect(document.documentElement).not.toHaveAttribute('data-modal')
  })
})
