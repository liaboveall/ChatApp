import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox'
import { Radio } from '@base-ui/react/radio'
import { RadioGroup } from '@base-ui/react/radio-group'
import { Switch as BaseSwitch } from '@base-ui/react/switch'
import type { LucideIcon } from 'lucide-react'
import { Check } from 'lucide-react'
import { motion } from 'motion/react'
import { type CSSProperties, type ReactNode, useId } from 'react'
import { springs } from '@/design/tokens.ts'
import { cx } from '@/lib/cx.ts'
import { Icon } from './icon.tsx'

type SwitchProps = {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** Accessible name (a visible label should use `labelledBy` instead). */
  label?: string
  labelledBy?: string
  disabled?: boolean
  id?: string
}

/** On/off switch. The on state shows a tick as well as the colour (docs/02 section 7). */
export function Switch({ checked, onCheckedChange, label, labelledBy, disabled, id }: SwitchProps) {
  return (
    <BaseSwitch.Root
      id={id}
      className="switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      aria-labelledby={labelledBy}
      nativeButton
      render={<button type="button" />}
    >
      <BaseSwitch.Thumb className="switch__thumb" />
    </BaseSwitch.Root>
  )
}

type CheckboxProps = {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  children: ReactNode
  disabled?: boolean
  id?: string
  invalid?: boolean
}

export function Checkbox({
  checked,
  onCheckedChange,
  children,
  disabled,
  id,
  invalid,
}: CheckboxProps) {
  const generated = useId()
  return (
    <div className="check">
      <BaseCheckbox.Root
        id={id ?? generated}
        className="check__box"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-invalid={invalid ? true : undefined}
        nativeButton
        render={<button type="button" />}
      >
        <BaseCheckbox.Indicator>
          <Icon icon={Check} size={16} strokeWidth={2.5} />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <label htmlFor={id ?? generated}>{children}</label>
    </div>
  )
}

export type SegmentedItem<T extends string> = {
  value: T
  label: string
  icon?: LucideIcon
  disabled?: boolean
}

type SegmentedControlProps<T extends string> = {
  value: T
  onValueChange: (value: T) => void
  items: SegmentedItem<T>[]
  /** Accessible name of the group. */
  label: string
  block?: boolean
  disabled?: boolean
}

/** Single choice among a few options, as a radio group (arrow keys move and select). */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  items,
  label,
  block,
  disabled,
}: SegmentedControlProps<T>) {
  const thumbId = useId()
  return (
    <RadioGroup
      className={cx('seg', block && 'seg--block')}
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      aria-label={label}
      disabled={disabled}
    >
      {items.map((item) => (
        <Radio.Root
          key={item.value}
          value={item.value}
          className="seg__item"
          disabled={item.disabled}
          nativeButton
          render={<button type="button" />}
        >
          {item.value === value ? (
            <motion.span
              layoutId={thumbId}
              className="seg__thumb"
              transition={{ type: 'spring', ...springs.snappy }}
            />
          ) : null}
          {item.icon ? <Icon icon={item.icon} size={16} /> : null}
          {item.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}

type SliderProps = {
  value: number
  min: number
  max: number
  step?: number
  onValueChange: (value: number) => void
  label: string
  valueText?: string
  id?: string
}

/** Native range input styled to the spec: keyboard and assistive technology work as the platform defines. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onValueChange,
  label,
  valueText,
  id,
}: SliderProps) {
  const fill = ((value - min) / (max - min)) * 100
  return (
    <input
      id={id}
      className="slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      aria-valuetext={valueText}
      style={{ '--p': `${fill}%` } as CSSProperties}
      onChange={(event) => onValueChange(Number(event.currentTarget.value))}
    />
  )
}
