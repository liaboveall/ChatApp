import type { LucideIcon } from 'lucide-react'
import { Loader2 } from 'lucide-react'
import type { ComponentProps, MouseEvent, ReactNode, Ref } from 'react'
import { cx } from '@/lib/cx.ts'
import { Icon } from './icon.tsx'
import { Tooltip } from './tooltip.tsx'

export type ButtonKind = 'filled' | 'tinted' | 'plain' | 'glass'
export type ButtonSize = 'sm' | 'md' | 'lg'

type ButtonProps = Omit<ComponentProps<'button'>, 'ref'> & {
  kind?: ButtonKind
  size?: ButtonSize
  block?: boolean
  danger?: boolean
  /** A request is running: the button stays focusable but ignores clicks and announces that it is busy. */
  busy?: boolean
  icon?: LucideIcon
  ref?: Ref<HTMLButtonElement>
}

/** Button in the four styles of the spec (docs/02 section 8): filled, tinted, plain, glass. */
export function Button({
  kind = 'filled',
  size = 'md',
  block,
  danger,
  busy,
  icon,
  className,
  children,
  disabled,
  type = 'button',
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  const inert = busy || disabled
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (inert) {
      event.preventDefault()
      return
    }
    onClick?.(event)
  }
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'btn',
        `btn--${kind}`,
        size !== 'md' && `btn--${size}`,
        block && 'btn--block',
        danger && 'btn--danger',
        className,
      )}
      aria-busy={busy ? true : undefined}
      aria-disabled={inert ? true : undefined}
      onClick={handleClick}
      {...rest}
    >
      {busy ? (
        <Icon icon={Loader2} size={16} className="spin" />
      ) : icon ? (
        <Icon icon={icon} size={16} />
      ) : null}
      {children}
    </button>
  )
}

type IconButtonProps = Omit<ComponentProps<'button'>, 'ref' | 'aria-label'> & {
  /** Accessible name; also the tooltip text. */
  label: string
  icon: LucideIcon
  shortcut?: string[]
  /** Round, plate or filled variants of the spec. */
  variant?: 'plain' | 'round' | 'plate' | 'filled'
  small?: boolean
  tooltip?: boolean
  iconSize?: 16 | 18 | 20
  ref?: Ref<HTMLButtonElement>
  children?: ReactNode
}

export function IconButton({
  label,
  icon,
  shortcut,
  variant = 'plain',
  small,
  tooltip = true,
  iconSize = 18,
  className,
  type = 'button',
  ref,
  children,
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-keyshortcuts={shortcut?.join('+') || undefined}
      className={cx(
        'icon-btn',
        variant !== 'plain' && `icon-btn--${variant}`,
        small && 'icon-btn--sm',
        className,
      )}
      {...rest}
    >
      <Icon icon={icon} size={iconSize} />
      {children}
    </button>
  )
  return tooltip ? (
    <Tooltip content={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}
