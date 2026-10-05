import { CircleAlert, CircleCheck, Eye, EyeOff, Search, X } from 'lucide-react'
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

type TextAreaFieldProps = Omit<ComponentProps<'textarea'>, 'ref'> & {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  ref?: Ref<HTMLTextAreaElement>
  wrapperClassName?: string
}

/** A labelled multi-line field with the same hint and error wiring as `TextField`. */
export function TextAreaField({
  label,
  hint,
  error,
  className,
  wrapperClassName,
  id,
  ref,
  rows = 3,
  ...rest
}: TextAreaFieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const messageId = `${inputId}-msg`
  return (
    <div className={cx('field', wrapperClassName)}>
      <label htmlFor={inputId} className="field__label">
        {label}
      </label>
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        className={cx('textarea', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={messageId}
        {...rest}
      />
      <div id={messageId} aria-live="polite">
        {error ? (
          <div className="field__error">
            <Icon icon={CircleAlert} size={16} />
            <span>{error}</span>
          </div>
        ) : hint ? (
          <div className="field__hint">{hint}</div>
        ) : null}
      </div>
    </div>
  )
}

type SelectFieldProps = Omit<ComponentProps<'select'>, 'ref'> & {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  /** Visually hide the label (it stays for screen readers). */
  hideLabel?: boolean
  ref?: Ref<HTMLSelectElement>
  wrapperClassName?: string
}

/** A labelled choice among a few options: the browser's own select (keyboard, touch and screen readers come with it). */
export function SelectField({
  label,
  hint,
  error,
  hideLabel,
  className,
  wrapperClassName,
  id,
  ref,
  children,
  ...rest
}: SelectFieldProps) {
  const generated = useId()
  const selectId = id ?? generated
  const messageId = `${selectId}-msg`
  return (
    <div className={cx('field', wrapperClassName)}>
      <label htmlFor={selectId} className={cx('field__label', hideLabel && 'sr-only')}>
        {label}
      </label>
      <select
        ref={ref}
        id={selectId}
        className={cx('select', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={messageId}
        {...rest}
      >
        {children}
      </select>
      <div id={messageId} aria-live="polite">
        {error ? (
          <div className="field__error">
            <Icon icon={CircleAlert} size={16} />
            <span>{error}</span>
          </div>
        ) : hint ? (
          <div className="field__hint">{hint}</div>
        ) : null}
      </div>
    </div>
  )
}

type SearchFieldProps = Omit<ComponentProps<'input'>, 'type' | 'ref' | 'onChange' | 'value'> & {
  label: string
  value: string
  onValueChange: (value: string) => void
  clearLabel: string
  ref?: Ref<HTMLInputElement>
}

/** A search input with a magnifier and a button that empties it; the label is for assistive technology. */
export function SearchField({
  label,
  value,
  onValueChange,
  clearLabel,
  className,
  ref,
  ...rest
}: SearchFieldProps) {
  return (
    <div className={cx('search search--field', className)}>
      <Icon icon={Search} size={16} />
      <input
        ref={ref}
        type="search"
        className="search__input"
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        {...rest}
      />
      {value !== '' ? (
        <IconButton
          label={clearLabel}
          icon={X}
          small
          tooltip={false}
          onClick={() => onValueChange('')}
        />
      ) : null}
    </div>
  )
}
