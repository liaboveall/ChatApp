import { CircleAlert, CircleCheck, Eye, EyeOff } from 'lucide-react'
import { type ComponentProps, type ReactNode, type Ref, useId, useState } from 'react'
import { cx } from '@/lib/cx.ts'
import { IconButton } from './button.tsx'
import { Icon } from './icon.tsx'

type TextFieldProps = Omit<ComponentProps<'input'>, 'size' | 'ref'> & {
  label: ReactNode
  /** Help text under the field while there is no error. */
  hint?: ReactNode
  /** Error text: shown instead of the hint, announced politely, marks the field invalid. */
  error?: string | null
  /** Positive feedback (for example "invite code is valid"). */
  ok?: string | null
  size?: 'md' | 'lg'
  /** Content placed inside the right end of the input (for example the show-password button). */
  trailing?: ReactNode
  /** Visually hide the label (it stays for screen readers). */
  hideLabel?: boolean
  ref?: Ref<HTMLInputElement>
  /** Class for the outer wrapper. */
  wrapperClassName?: string
}

/** A labelled input with hint, error and success messages wired up through aria-describedby. */
export function TextField({
  label,
  hint,
  error,
  ok,
  size = 'md',
  trailing,
  hideLabel,
  className,
  wrapperClassName,
  id,
  ref,
  ...rest
}: TextFieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const messageId = `${inputId}-msg`
  const input = (
    <input
      ref={ref}
      id={inputId}
      className={cx('input', size === 'lg' && 'input--lg', className)}
      aria-invalid={error ? true : undefined}
      aria-describedby={messageId}
      {...rest}
    />
  )
  return (
    <div className={cx('field', wrapperClassName)}>
      <label htmlFor={inputId} className={cx('field__label', hideLabel && 'sr-only')}>
        {label}
      </label>
      {trailing ? (
        <div className="input-wrap">
          {input}
          {trailing}
        </div>
      ) : (
        input
      )}
      <div id={messageId} aria-live="polite">
        {error ? (
          <div className="field__error">
            <Icon icon={CircleAlert} size={16} />
            <span>{error}</span>
          </div>
        ) : ok ? (
          <div className="field__ok">
            <Icon icon={CircleCheck} size={16} />
            <span>{ok}</span>
          </div>
        ) : hint ? (
          <div className="field__hint">{hint}</div>
        ) : null}
      </div>
    </div>
  )
}

type PasswordFieldProps = Omit<ComponentProps<typeof TextField>, 'type' | 'trailing'> & {
  showLabel: string
  hideLabelText: string
}

/** Password input with a show/hide toggle. */
export function PasswordField({ showLabel, hideLabelText, ...rest }: PasswordFieldProps) {
  const [shown, setShown] = useState(false)
  return (
    <TextField
      {...rest}
      type={shown ? 'text' : 'password'}
      trailing={
        <IconButton
          label={shown ? hideLabelText : showLabel}
          icon={shown ? EyeOff : Eye}
          aria-pressed={shown}
          tooltip={false}
          onClick={() => setShown((value) => !value)}
        />
      }
    />
  )
}
