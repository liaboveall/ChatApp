import type { adminAuditSchema } from '@chatapp/contracts'
import { useState } from 'react'
import type { z } from 'zod'
import { Button } from '@/components/ui/button.tsx'
import { TextField } from '@/components/ui/fields.tsx'
import { m } from '@/paraglide/messages.js'

export type AuditFilters = { action?: string; actorId?: string; after?: string; before?: string }

export function AuditFilterForm({ onApply }: { onApply: (filters: AuditFilters) => void }) {
  const [action, setAction] = useState(''),
    [actorId, setActorId] = useState(''),
    [after, setAfter] = useState(''),
    [before, setBefore] = useState('')
  return (
    <form
      className="admin-search admin-audit-filters"
      onSubmit={(event) => {
        event.preventDefault()
        onApply({
          ...(action.trim() ? { action: action.trim() } : {}),
          ...(actorId.trim() ? { actorId: actorId.trim() } : {}),
          ...(after ? { after: new Date(`${after}Z`).toISOString() } : {}),
          ...(before ? { before: new Date(`${before}Z`).toISOString() } : {}),
        })
      }}
    >
      <TextField
        label={m.admin_audit_action_filter()}
        value={action}
        maxLength={100}
        onChange={(event) => setAction(event.currentTarget.value)}
      />
      <TextField
        label={m.admin_audit_actor_filter()}
        value={actorId}
        maxLength={36}
        onChange={(event) => setActorId(event.currentTarget.value)}
      />
      <TextField
        label={`${m.admin_audit_after()} (UTC)`}
        type="datetime-local"
        value={after}
        onChange={(event) => setAfter(event.currentTarget.value)}
      />
      <TextField
        label={`${m.admin_audit_before()} (UTC)`}
        type="datetime-local"
        value={before}
        min={after || undefined}
        onChange={(event) => setBefore(event.currentTarget.value)}
      />
      <Button type="submit">{m.admin_audit_apply()}</Button>
    </form>
  )
}

export function AuditEntry({
  entry,
  actionLabel,
  onOpenTarget,
}: {
  entry: z.infer<typeof adminAuditSchema>
  actionLabel: string
  onOpenTarget: (type: string, id: string) => void
}) {
  const summary = entry.summary
  return (
    <article className="admin-row glass-text squircle">
      <div className="admin-row__main">
        <strong>{actionLabel}</strong>
        <p>
          {entry.actorName ?? m.admin_role_admin()} ·{' '}
          {new Date(entry.createdAt).toLocaleString(document.documentElement.lang)}
        </p>
        {entry.targetId ? (
          <p>{m.admin_audit_target({ type: entry.targetType ?? '', id: entry.targetId })}</p>
        ) : null}
        {summary.roleChanged ? <p>{m.admin_audit_role_changed()}</p> : null}
        {summary.status ? <p>{m.admin_audit_status({ status: summary.status })}</p> : null}
        {summary.version !== undefined || summary.runContentDays !== undefined ? (
          <p>
            {m.admin_audit_changes({
              changes: [
                summary.version !== undefined ? `v${summary.version}` : '',
                summary.runContentDays !== undefined
                  ? m.admin_audit_retention({ days: summary.runContentDays })
                  : '',
              ]
                .filter(Boolean)
                .join(' · '),
            })}
          </p>
        ) : null}
      </div>
      {entry.targetId && ['user', 'conversation', 'report'].includes(entry.targetType ?? '') ? (
        <Button
          kind="plain"
          size="sm"
          onClick={() => onOpenTarget(entry.targetType ?? '', entry.targetId ?? '')}
        >
          {m.admin_audit_open_target()}
        </Button>
      ) : null}
    </article>
  )
}
