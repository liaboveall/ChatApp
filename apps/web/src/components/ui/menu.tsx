import { Menu as BaseMenu } from '@base-ui/react/menu'
import type { LucideIcon } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import { cx } from '@/lib/cx.ts'
import { Icon } from './icon.tsx'

type MenuProps = {
  /** The element that opens the menu (a button). */
  trigger: ReactElement
  /** Start open (stories and tests). */
  defaultOpen?: boolean
  children: ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
}

/** Popup menu on glass, built on Base UI (focus, typeahead and arrow keys come with it). */
export function Menu({
  trigger,
  children,
  defaultOpen,
  align = 'start',
  side = 'bottom',
}: MenuProps) {
  return (
    <BaseMenu.Root defaultOpen={defaultOpen}>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={6} className="positioner">
          <BaseMenu.Popup className="menu glass-text squircle">{children}</BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

type MenuItemProps = {
  children: ReactNode
  icon?: LucideIcon
  hint?: ReactNode
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
}

export function MenuItem({ children, icon, hint, danger, disabled, onClick }: MenuItemProps) {
  return (
    <BaseMenu.Item
      className={cx('menu__item', danger && 'menu__item--danger')}
      disabled={disabled}
      onClick={onClick}
    >
      {icon ? <Icon icon={icon} size={16} /> : null}
      <span>{children}</span>
      {hint ? <span className="menu__hint">{hint}</span> : null}
    </BaseMenu.Item>
  )
}

export function MenuGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <BaseMenu.Group className="menu__group">
      {label ? <BaseMenu.GroupLabel className="menu__label">{label}</BaseMenu.GroupLabel> : null}
      {children}
    </BaseMenu.Group>
  )
}
