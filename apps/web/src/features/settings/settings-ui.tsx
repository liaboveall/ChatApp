import type { ReactNode } from 'react'
import { cx } from '@/lib/cx.ts'

/** A titled block of settings. */
export function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="group">
      {title ? <h3 className="group__title">{title}</h3> : null}
      {children}
    </section>
  )
}

/** The rounded card that holds rows. */
export function Box({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('group__box', className)}>
      <div className="rows">{children}</div>
    </div>
  )
}

type RowProps = {
  title: ReactNode
  help?: ReactNode
  /** The control on the right. */
  children?: ReactNode
  /** Id of the control, so the title is its label. */
  htmlFor?: string
  titleId?: string
}

/** Settings row: label and help on the left, the control on the right. */
export function Row({ title, help, children, htmlFor, titleId }: RowProps) {
  const Title = htmlFor ? 'label' : 'div'
  return (
    <div className="row">
      <div className="row__main">
        <Title id={titleId} htmlFor={htmlFor} className="row__title">
          {title}
        </Title>
        {help ? <div className="row__help">{help}</div> : null}
      </div>
      {children ? <div className="row__control">{children}</div> : null}
    </div>
  )
}
