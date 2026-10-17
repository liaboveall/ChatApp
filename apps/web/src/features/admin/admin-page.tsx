import {
  adminAgentRunDetailSchema,
  adminAgentRunListSchema,
  adminAuditLogsSchema,
  type adminConversationSchema,
  adminConversationsSchema,
  adminInvitesSchema,
  adminReportsSchema,
  adminUsageSchema,
  adminUserSchema,
  adminUsersSchema,
  okResponseSchema,
  reportContextSchema,
  type SiteLimits,
  siteSettingsSchema,
  siteSettingsUpdateSchema,
} from '@chatapp/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import type { z } from 'zod'
import { forScreen } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { ConfirmDialog } from '@/components/ui/confirm-dialog.tsx'
import { Switch } from '@/components/ui/controls.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { TextAreaField, TextField } from '@/components/ui/fields.tsx'
import { reportReasonLabel } from '@/features/reports/report-dialog.tsx'
import { api, newIdempotencyKey } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { meQuery } from '@/lib/queries.ts'
import { useSyncScope } from '@/lib/sync/hooks.ts'
import { registerStoreReset } from '@/lib/sync/stores.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { AuditEntry, AuditFilterForm, type AuditFilters } from './audit-log.tsx'

type Section =
  | 'users'
  | 'invites'
  | 'conversations'
  | 'reports'
  | 'audit'
  | 'usage'
  | 'runs'
  | 'policy'
const tabs: { id: Section; label: () => string }[] = [
  { id: 'users', label: () => m.admin_users() },
  { id: 'invites', label: () => m.admin_invites() },
  { id: 'conversations', label: () => m.admin_conversations() },
  { id: 'reports', label: () => m.admin_reports() },
  { id: 'audit', label: () => m.admin_audit() },
  { id: 'usage', label: () => m.admin_usage() },
  { id: 'runs', label: () => m.admin_runs() },
  { id: 'policy', label: () => m.admin_policy() },
]
type AdminUser = z.infer<typeof adminUserSchema>
type CurrentSettings = z.infer<typeof siteSettingsSchema>
function PageStatus({
  error,
  pending,
  children,
}: {
  error: unknown
  pending: boolean
  children: ReactNode
}) {
  return error ? (
    <Banner tone="danger">{describeError(error)}</Banner>
  ) : pending ? (
    <Banner>{m.common_loading()}</Banner>
  ) : (
    <>{children}</>
  )
}
const at = (value: string) => new Date(value).toLocaleString(document.documentElement.lang)
const money = (value: number) =>
  (value / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
export function AdminPage() {
  const [section, setSection] = useState<Section>('users'),
    [cursor, setCursor] = useState<string | undefined>(),
    [search, setSearch] = useState(''),
    [searchDraft, setSearchDraft] = useState('')
  const [dialog, setDialog] = useState<ReactNode>(null),
    [confirm, setConfirm] = useState<{ title: string; text: string; action: () => void } | null>(
      null,
    )
  const [busy, setBusy] = useState(false)
  const [auditFilters, setAuditFilters] = useState<AuditFilters>({})
  useEffect(
    () =>
      registerStoreReset(() => {
        setDialog(null)
        setConfirm(null)
        setBusy(false)
        setSearch('')
        setSearchDraft('')
        setCursor(undefined)
        setAuditFilters({})
      }),
    [],
  )
  const scope = useSyncScope(),
    me = useQuery(meQuery),
    client = useQueryClient()
  const prefix = ['site-admin', scope?.userId, scope?.authEpoch, scope?.restoreEpoch] as const
  const suffix = new URLSearchParams({
    ...(cursor ? { cursor } : {}),
    ...(search ? { query: search } : {}),
    ...(section === 'audit' ? auditFilters : {}),
  }).toString()
  const query = useQuery({
    queryKey: [...prefix, section, cursor, search, auditFilters],
    enabled: !!scope && me.data?.role === 'admin',
    queryFn: async () => {
      switch (section) {
        case 'users':
          return {
            section,
            ...(await api(`/api/admin/users?${suffix}`, { schema: adminUsersSchema })),
          }
        case 'invites':
          return {
            section,
            ...(await api(`/api/admin/invites?${suffix}`, { schema: adminInvitesSchema })),
          }
        case 'conversations':
          return {
            section,
            ...(await api(`/api/admin/conversations?${suffix}`, {
              schema: adminConversationsSchema,
            })),
          }
        case 'reports':
          return {
            section,
            ...(await api(`/api/admin/reports?${suffix}`, { schema: adminReportsSchema })),
          }
        case 'audit':
          return {
            section,
            ...(await api(`/api/admin/audit-logs?${suffix}`, { schema: adminAuditLogsSchema })),
          }
        case 'usage':
          return { section, ...(await api('/api/admin/ai-usage', { schema: adminUsageSchema })) }
        case 'runs':
          return {
            section,
            ...(await api(
              `/api/admin/agent-runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
              { schema: adminAgentRunListSchema },
            )),
          }
        case 'policy':
          return { section, ...(await api('/api/admin/settings', { schema: siteSettingsSchema })) }
      }
    },
  })
  const data = query.data
  const refresh = () => {
    void client.invalidateQueries({ queryKey: prefix })
    void client.invalidateQueries({ queryKey: ['site-limits'] })
  }
  async function write(path: string, input: unknown = {}, method: 'POST' | 'PATCH' = 'POST') {
    if (busy) return
    setBusy(true)
    try {
      const result = await forScreen(null, () =>
        api(path, { method, json: input, idempotencyKey: newIdempotencyKey() }),
      )
      if (result === null) return
      setBusy(false)
      setDialog(null)
      refresh()
      showToast(m.admin_saved())
    } catch (error) {
      setBusy(false)
      showToast(describeError(error))
    }
  }
  async function viewContext(id: string) {
    try {
      const result = await forScreen(null, () =>
        api(`/api/admin/reports/${id}/context`, { schema: reportContextSchema }),
      )
      if (!result) return
      setDialog(
        <Dialog
          open
          title={m.admin_open_context()}
          description={m.admin_context_notice()}
          onOpenChange={(open) => !open && setDialog(null)}
        >
          <div className="admin-context scroll">
            {result.available ? (
              result.messages.map((item) => (
                <section
                  key={item.id}
                  className={item.reported ? 'admin-context__reported' : undefined}
                >
                  <strong>
                    {item.reported ? `${m.admin_reported()} · ` : ''}
                    {item.senderName || m.admin_unavailable()}
                  </strong>
                  <time>{at(item.createdAt)}</time>
                  <p>{item.body ?? m.admin_unavailable()}</p>
                </section>
              ))
            ) : (
              <p>{m.admin_unavailable()}</p>
            )}
          </div>
        </Dialog>,
      )
    } catch (error) {
      showToast(describeError(error))
    }
  }
  async function viewRun(id: string) {
    try {
      const result = await forScreen(null, () =>
        api(`/api/admin/agent-runs/${id}`, { schema: adminAgentRunDetailSchema }),
      )
      if (!result) return
      const content = result.content
      setDialog(
        <Dialog
          open
          title={m.admin_run_content()}
          description={m.admin_run_notice()}
          onOpenChange={(open) => !open && setDialog(null)}
        >
          <div className="admin-context scroll">
            {content.available === 'site_key' ? (
              <>
                <h3>{m.admin_history()}</h3>
                <pre>{content.history.map(readableContent).join('\n\n')}</pre>
                <h3>{m.admin_steps()}</h3>
                {content.steps.map((step) => (
                  <pre key={step.index}>{readableContent(step)}</pre>
                ))}
                {content.approvals.map((item) => (
                  <pre key={item.id}>{readableContent(item)}</pre>
                ))}
              </>
            ) : (
              <p>
                {content.available === 'own_key' ? m.admin_own_key() : m.admin_content_expired()}
              </p>
            )}
          </div>
        </Dialog>,
      )
    } catch (error) {
      showToast(describeError(error))
    }
  }
  async function viewBans(id: string) {
    try {
      const { z } = await import('zod')
      const result = await forScreen(null, () =>
        api(`/api/admin/conversations/${id}/bans`, {
          schema: z.object({
            bans: z.array(
              z.object({ id: z.uuid(), name: z.string(), reason: z.string().nullable() }),
            ),
          }),
        }),
      )
      if (!result) return
      setDialog(
        <Dialog open title={m.admin_bans()} onOpenChange={(open) => !open && setDialog(null)}>
          <div className="admin-context scroll">
            {result.bans.length ? (
              result.bans.map((ban) => (
                <div className="admin-row" key={ban.id}>
                  <div>
                    <strong>{ban.name}</strong>
                    <p>{ban.reason}</p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() =>
                      void write(`/api/admin/conversations/${id}/unban`, { userId: ban.id })
                    }
                  >
                    {m.admin_unban()}
                  </Button>
                </div>
              ))
            ) : (
              <p>{m.admin_empty()}</p>
            )}
          </div>
        </Dialog>,
      )
    } catch (error) {
      showToast(describeError(error))
    }
  }
  if (me.data?.role !== 'admin') return <Banner>{m.admin_forbidden()}</Banner>
  return (
    <div className="admin-page scroll">
      <header className="admin-head">
        <h1 className="text-title-1">{m.admin_title()}</h1>
        <Button kind="plain" onClick={refresh}>
          {m.admin_refresh()}
        </Button>
      </header>
      <nav className="admin-tabs" aria-label={m.admin_title()}>
        {tabs.map((tab) => (
          <Button
            key={tab.id}
            kind={section === tab.id ? 'tinted' : 'plain'}
            aria-pressed={section === tab.id}
            onClick={() => {
              setSection(tab.id)
              setCursor(undefined)
              setSearch('')
              setSearchDraft('')
              setAuditFilters({})
              setDialog(null)
            }}
          >
            {tab.label()}
          </Button>
        ))}
      </nav>
      {section === 'users' || section === 'conversations' || section === 'reports' ? (
        <form
          className="admin-search"
          onSubmit={(event) => {
            event.preventDefault()
            setSearch(searchDraft.trim())
            setCursor(undefined)
          }}
        >
          <TextField
            label={section === 'reports' ? m.admin_report_filter() : m.admin_search()}
            name="search"
            maxLength={100}
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
          />
          <Button type="submit">{m.admin_search()}</Button>
        </form>
      ) : null}
      {section === 'audit' ? (
        <AuditFilterForm
          onApply={(filters) => {
            setAuditFilters(filters)
            setCursor(undefined)
          }}
        />
      ) : null}
      <PageStatus error={query.error} pending={query.isPending}>
        {data?.section === 'users' ? (
          <div className="admin-list">
            {data.users.length ? (
              data.users.map((user) => (
                <article className="admin-row glass-text squircle" key={user.id}>
                  <div className="admin-row__main">
                    <strong>{user.name}</strong>
                    <p>
                      {user.username ? `@${user.username} · ` : ''}
                      {user.email}
                    </p>
                    <p>
                      {user.role === 'admin' ? m.admin_role_admin() : m.admin_role_user()}
                      {user.banned ? ` · ${m.admin_banned()}` : ''}
                      {!user.emailVerified ? ` · ${m.admin_unverified()}` : ''}
                    </p>
                  </div>
                  <div className="admin-actions">
                    <Button
                      size="sm"
                      kind="plain"
                      onClick={() =>
                        setDialog(
                          <UserLimits
                            user={user}
                            onClose={() => setDialog(null)}
                            onSaved={refresh}
                          />,
                        )
                      }
                    >
                      {m.admin_limits()}
                    </Button>
                    {!user.emailVerified ? (
                      <Button
                        size="sm"
                        kind="plain"
                        busy={busy}
                        onClick={() =>
                          setConfirm({
                            title: m.admin_verify(),
                            text: m.admin_change_confirm(),
                            action: () =>
                              void write(`/api/admin/users/${user.id}/verify-email`, {
                                expectedVersion: user.meVersion,
                              }),
                          })
                        }
                      >
                        {m.admin_verify()}
                      </Button>
                    ) : null}
                    {user.banned ? (
                      <Button
                        size="sm"
                        kind="plain"
                        busy={busy}
                        onClick={() =>
                          setConfirm({
                            title: m.admin_unban(),
                            text: m.admin_change_confirm(),
                            action: () =>
                              void write(`/api/admin/users/${user.id}/unban`, {
                                expectedVersion: user.meVersion,
                              }),
                          })
                        }
                      >
                        {m.admin_unban()}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        kind="plain"
                        danger
                        onClick={() =>
                          setDialog(
                            <BanUser
                              user={user}
                              onClose={() => setDialog(null)}
                              onSaved={refresh}
                            />,
                          )
                        }
                      >
                        {m.admin_ban()}
                      </Button>
                    )}
                  </div>
                </article>
              ))
            ) : (
              <p>{m.admin_empty()}</p>
            )}
          </div>
        ) : null}
        {data?.section === 'invites' ? (
          <div className="admin-list">
            {data.invites.length ? (
              data.invites.map((invite) => (
                <article className="admin-row glass-text squircle" key={invite.id}>
                  <div>
                    <strong>{invite.creatorName}</strong>
                    <p>{invite.note}</p>
                    <p>
                      {m.admin_used({ used: invite.useCount, quota: invite.maxUses ?? '∞' })} ·{' '}
                      {at(invite.createdAt)}
                    </p>
                  </div>
                  {!invite.revokedAt ? (
                    <Button
                      size="sm"
                      kind="plain"
                      danger
                      busy={busy}
                      onClick={() =>
                        setConfirm({
                          title: m.admin_revoke(),
                          text: m.admin_revoke_confirm(),
                          action: () => void write(`/api/admin/invites/${invite.id}/revoke`),
                        })
                      }
                    >
                      {m.admin_revoke()}
                    </Button>
                  ) : null}
                </article>
              ))
            ) : (
              <p>{m.admin_empty()}</p>
            )}
          </div>
        ) : null}
        {data?.section === 'conversations' ? (
          <div className="admin-list">
            {data.conversations.length ? (
              data.conversations.map((conversation) => (
                <article className="admin-row glass-text squircle" key={conversation.id}>
                  <div>
                    <strong>{conversation.name}</strong>
                    <p>
                      {m.admin_members({ count: conversation.memberCount })} ·{' '}
                      {m.admin_owner({ name: conversation.ownerName ?? m.admin_unavailable() })}
                    </p>
                    <p>{conversation.archivedAt ? m.admin_archived() : null}</p>
                  </div>
                  <div className="admin-actions">
                    <Button kind="plain" size="sm" onClick={() => void viewBans(conversation.id)}>
                      {m.admin_bans()}
                    </Button>
                    <Button
                      kind="plain"
                      size="sm"
                      busy={busy}
                      onClick={() =>
                        conversation.archivedAt
                          ? setDialog(
                              <RestoreConversation
                                conversation={conversation}
                                onClose={() => setDialog(null)}
                                onSaved={refresh}
                              />,
                            )
                          : setConfirm({
                              title: conversation.archivedAt
                                ? m.admin_restore()
                                : m.admin_archive(),
                              text: m.admin_archive_confirm(),
                              action: () =>
                                void write(
                                  `/api/admin/conversations/${conversation.id}/${conversation.archivedAt ? 'restore' : 'archive'}`,
                                  { expectedVersion: conversation.metadataVersion },
                                ),
                            })
                      }
                    >
                      {conversation.archivedAt ? m.admin_restore() : m.admin_archive()}
                    </Button>
                  </div>
                </article>
              ))
            ) : (
              <p>{m.admin_empty()}</p>
            )}
          </div>
        ) : null}
        {data?.section === 'reports' ? (
          <div className="admin-list">
            {data.reports.length ? (
              data.reports.map((report) => (
                <article className="admin-row glass-text squircle" key={report.id}>
                  <div>
                    <strong>{reportReasonLabel(report.reason)}</strong>
                    <p>
                      {report.reporterName} · {at(report.createdAt)}
                    </p>
                    <p>{report.details}</p>
                    <p>
                      {{
                        open: () => m.admin_report_open(),
                        resolved: () => m.admin_report_resolved(),
                        dismissed: () => m.admin_report_dismissed(),
                      }[report.status]()}
                    </p>
                  </div>
                  <div className="admin-actions">
                    <Button size="sm" kind="plain" onClick={() => void viewContext(report.id)}>
                      {m.admin_open_context()}
                    </Button>
                    {report.status === 'open' ? (
                      <Button
                        size="sm"
                        kind="plain"
                        onClick={() =>
                          setDialog(
                            <ReportDecision
                              report={report}
                              onClose={() => setDialog(null)}
                              onSaved={refresh}
                            />,
                          )
                        }
                      >
                        {m.admin_resolve()}
                      </Button>
                    ) : null}
                  </div>
                </article>
              ))
            ) : (
              <p>{m.admin_empty()}</p>
            )}
          </div>
        ) : null}
        {data?.section === 'audit' ? (
          <div className="admin-list">
            {data.entries.length ? (
              data.entries.map((entry) => (
                <AuditEntry
                  key={entry.id}
                  entry={entry}
                  actionLabel={auditLabel(entry.action)}
                  onOpenTarget={(type, id) => {
                    setSection(
                      type === 'user'
                        ? 'users'
                        : type === 'conversation'
                          ? 'conversations'
                          : 'reports',
                    )
                    setSearch(id)
                    setSearchDraft(id)
                    setCursor(undefined)
                    setAuditFilters({})
                  }}
                />
              ))
            ) : (
              <p>{m.admin_empty()}</p>
            )}
          </div>
        ) : null}
        {data?.section === 'usage' ? (
          <div className="admin-list">
            {data.budget ? (
              <Banner>
                {m.admin_budget_state({
                  settled: money(data.budget.settledMicroUsd),
                  reserved: money(data.budget.reservedMicroUsd),
                  limit: money(data.budget.limitMicroUsd),
                })}
              </Banner>
            ) : null}
            {data.usage.length ? (
              data.usage.map((row) => (
                <p key={row.day}>
                  {m.admin_usage_day({
                    day: row.day,
                    input: row.inputTokens,
                    output: row.outputTokens,
                    cost: money(row.costMicroUsd),
                  })}
                </p>
              ))
            ) : (
              <p>{m.admin_empty()}</p>
            )}
          </div>
        ) : null}
        {data?.section === 'runs' ? (
          <div className="admin-list">
            <Banner>{m.admin_run_notice()}</Banner>
            {data.runs.length ? (
              data.runs.map((run) => (
                <article className="admin-row glass-text squircle" key={run.id}>
                  <div>
                    <strong>{run.model}</strong>
                    <p>
                      {at(run.createdAt)} ·{' '}
                      {run.keySource === 'user' ? m.admin_own_key() : m.admin_admission()}
                    </p>
                    <p>
                      {m.admin_usage_day({
                        day: '',
                        input: run.usage.inputTokens,
                        output: run.usage.outputTokens,
                        cost: run.usage.costUsd,
                      })}
                    </p>
                  </div>
                  <Button size="sm" kind="plain" onClick={() => void viewRun(run.id)}>
                    {m.admin_run_content()}
                  </Button>
                </article>
              ))
            ) : (
              <p>{m.admin_empty()}</p>
            )}
          </div>
        ) : null}
        {data?.section === 'policy' ? (
          <PolicyForm key={data.version} settings={data} onSaved={refresh} />
        ) : null}
        {data && 'nextCursor' in data ? (
          <div className="admin-actions">
            {cursor ? (
              <Button kind="plain" onClick={() => setCursor(undefined)}>
                {m.admin_first()}
              </Button>
            ) : null}
            {data.nextCursor ? (
              <Button kind="tinted" onClick={() => setCursor(data.nextCursor ?? undefined)}>
                {m.admin_more()}
              </Button>
            ) : null}
          </div>
        ) : null}
      </PageStatus>
      {dialog}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm?.title ?? ''}
        description={confirm?.text ?? ''}
        confirmLabel={confirm?.title ?? ''}
        onConfirm={() => {
          const action = confirm?.action
          setConfirm(null)
          action?.()
        }}
      />
    </div>
  )
}

function useAdminSubmit(onSaved: () => void, onClose?: () => void) {
  const [busy, setBusy] = useState(false)
  const submit = async (path: string, input: unknown, method: 'PATCH' | 'POST' = 'PATCH') => {
    if (busy) return
    setBusy(true)
    try {
      const result = await forScreen(null, () =>
        api(path, {
          method,
          json: input,
          idempotencyKey: newIdempotencyKey(),
          schema: okResponseSchema.or(adminUserSchema).or(siteSettingsSchema),
        }),
      )
      if (result === null) return
      setBusy(false)
      onClose?.()
      onSaved()
      showToast(m.admin_saved())
    } catch (error) {
      setBusy(false)
      showToast(describeError(error))
    }
  }
  return { busy, submit }
}
function RestoreConversation({
  conversation,
  onSaved,
  onClose,
}: {
  conversation: z.infer<typeof adminConversationSchema>
  onSaved: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(''),
    [search, setSearch] = useState(''),
    [owner, setOwner] = useState('')
  const scope = useSyncScope()
  const { busy, submit } = useAdminSubmit(onSaved, onClose)
  const candidates = useQuery({
    queryKey: ['restore-owner', scope?.userId, scope?.authEpoch, scope?.restoreEpoch, search],
    enabled: !!scope && conversation.ownerName === null,
    queryFn: () =>
      api(`/api/admin/users?limit=100${search ? `&query=${encodeURIComponent(search)}` : ''}`, {
        schema: adminUsersSchema,
      }),
  })
  return (
    <Dialog
      open
      title={m.admin_restore()}
      description={m.admin_restore_hint()}
      onOpenChange={(open) => !open && onClose()}
    >
      <form
        className="admin-form"
        onSubmit={(event) => {
          event.preventDefault()
          void submit(
            `/api/admin/conversations/${conversation.id}/restore`,
            {
              expectedVersion: conversation.metadataVersion,
              ...(name.trim() ? { name: name.trim() } : {}),
              ...(owner ? { ownerUserId: owner } : {}),
            },
            'POST',
          )
        }}
      >
        <TextField
          label={m.admin_restore_name()}
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        {conversation.ownerName === null ? (
          <>
            <TextField
              label={m.admin_search()}
              value={search}
              maxLength={100}
              onChange={(event) => {
                setSearch(event.currentTarget.value)
                setOwner('')
              }}
            />
            <PageStatus error={candidates.error} pending={candidates.isPending}>
              <label className="field">
                <span className="field__label">{m.admin_restore_owner()}</span>
                <select
                  required
                  className="input"
                  value={owner}
                  onChange={(event) => setOwner(event.currentTarget.value)}
                >
                  <option value="">{m.admin_restore_owner()}</option>
                  {candidates.data?.users
                    .filter((user) => !user.banned && user.active && user.emailVerified)
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                        {user.username ? ` (@${user.username})` : ''}
                      </option>
                    ))}
                </select>
              </label>
            </PageStatus>
          </>
        ) : null}
        <div className="dialog__actions">
          <Button kind="plain" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button type="submit" busy={busy}>
            {m.admin_restore()}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
function UserLimits({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser
  onClose: () => void
  onSaved: () => void
}) {
  const [role, setRole] = useState(user.role),
    [invites, setInvites] = useState(String(user.inviteQuota))
  const [storage, setStorage] = useState(
    user.storageQuotaBytes === null ? '' : String(user.storageQuotaBytes / 1_048_576),
  )
  const [tokens, setTokens] = useState(
    user.aiDailyTokens === null ? '' : String(user.aiDailyTokens),
  )
  const save = useAdminSubmit(onSaved, onClose)
  return (
    <Dialog
      open
      title={m.admin_limits()}
      description={m.admin_change_confirm()}
      onOpenChange={(open) => !open && onClose()}
    >
      <form
        className="admin-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save.submit(`/api/admin/users/${user.id}`, {
            expectedVersion: user.meVersion,
            role,
            inviteQuota: Number(invites),
            storageQuotaBytes: storage ? Math.round(Number(storage) * 1_048_576) : null,
            aiDailyTokens: tokens ? Number(tokens) : null,
          })
        }}
      >
        <label className="field">
          <span className="field__label">{m.admin_role()}</span>
          <select
            className="input"
            value={role}
            onChange={(event) => setRole(event.currentTarget.value === 'admin' ? 'admin' : 'user')}
          >
            <option value="user">{m.admin_role_user()}</option>
            <option value="admin">{m.admin_role_admin()}</option>
          </select>
        </label>
        <TextField
          label={m.admin_invite_quota()}
          type="number"
          min={user.invitesUsed}
          max={100_000}
          required
          value={invites}
          onChange={(event) => setInvites(event.currentTarget.value)}
        />
        <TextField
          label={m.admin_storage_quota()}
          hint={m.admin_default_hint()}
          type="number"
          min={0}
          step="any"
          value={storage}
          onChange={(event) => setStorage(event.currentTarget.value)}
        />
        <TextField
          label={m.admin_daily_tokens()}
          hint={m.admin_default_hint()}
          type="number"
          min={0}
          step={1}
          value={tokens}
          onChange={(event) => setTokens(event.currentTarget.value)}
        />
        <div className="dialog__actions">
          <Button kind="plain" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button type="submit" busy={save.busy}>
            {m.common_save()}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
function BanUser({
  user,
  onClose,
  onSaved,
}: {
  user: AdminUser
  onClose: () => void
  onSaved: () => void
}) {
  const [reason, setReason] = useState(''),
    save = useAdminSubmit(onSaved, onClose)
  return (
    <Dialog
      open
      title={m.admin_ban()}
      description={m.admin_change_confirm()}
      onOpenChange={(open) => !open && onClose()}
    >
      <form
        className="admin-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save.submit(
            `/api/admin/users/${user.id}/ban`,
            { expectedVersion: user.meVersion, reason },
            'POST',
          )
        }}
      >
        <TextAreaField
          label={m.admin_reason()}
          required
          maxLength={400}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
        <div className="dialog__actions">
          <Button kind="plain" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button type="submit" busy={save.busy} danger>
            {m.admin_ban()}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
function ReportDecision({
  report,
  onClose,
  onSaved,
}: {
  report: z.infer<typeof adminReportsSchema>['reports'][number]
  onClose: () => void
  onSaved: () => void
}) {
  const [note, setNote] = useState(''),
    save = useAdminSubmit(onSaved, onClose)
  return (
    <Dialog open title={m.admin_resolve()} onOpenChange={(open) => !open && onClose()}>
      <div className="admin-form">
        <TextAreaField
          label={m.admin_resolution()}
          maxLength={1000}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />
        <div className="dialog__actions">
          <Button kind="plain" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button
            kind="plain"
            busy={save.busy}
            onClick={() =>
              void save.submit(`/api/admin/reports/${report.id}`, {
                expectedVersion: report.version,
                status: 'dismissed',
                resolutionNote: note,
              })
            }
          >
            {m.admin_dismiss()}
          </Button>
          <Button
            busy={save.busy}
            onClick={() =>
              void save.submit(`/api/admin/reports/${report.id}`, {
                expectedVersion: report.version,
                status: 'resolved',
                resolutionNote: note,
              })
            }
          >
            {m.admin_resolve()}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
const policyFields: { key: keyof SiteLimits; label: () => string; factor: number }[] = [
  { key: 'messageRecallWindowMs', label: () => m.admin_recall_window(), factor: 1000 },
  { key: 'messageEditWindowMs', label: () => m.admin_edit_window(), factor: 3600000 },
  { key: 'fileBytes', label: () => m.admin_file_limit(), factor: 1048576 },
  { key: 'imageBytes', label: () => m.admin_image_limit(), factor: 1048576 },
  { key: 'groupMemberLimit', label: () => m.admin_group_limit(), factor: 1 },
  { key: 'channelMemberLimit', label: () => m.admin_channel_limit(), factor: 1 },
  { key: 'messageRateConversationLimit', label: () => m.admin_message_room_rate(), factor: 1 },
  { key: 'messageRateUserLimit', label: () => m.admin_message_user_rate(), factor: 1 },
  { key: 'uploadsPerHour', label: () => m.admin_upload_rate(), factor: 1 },
  { key: 'maxConversationsPerUser', label: () => m.admin_conversation_limit(), factor: 1 },
  { key: 'maxFutureTasksPerUser', label: () => m.admin_task_limit(), factor: 1 },
  { key: 'fastSteps', label: () => m.admin_fast_steps(), factor: 1 },
  { key: 'deepSteps', label: () => m.admin_deep_steps(), factor: 1 },
  { key: 'fastDurationMs', label: () => m.admin_fast_duration(), factor: 1000 },
  { key: 'deepDurationMs', label: () => m.admin_deep_duration(), factor: 1000 },
]
function PolicyForm({ settings, onSaved }: { settings: CurrentSettings; onSaved: () => void }) {
  const [days, setDays] = useState(String(settings.policy.runContentDays)),
    [daily, setDaily] = useState(String(settings.policy.userDailyTokens))
  const [budget, setBudget] = useState(money(settings.policy.monthlyMicroUsd)),
    [paused, setPaused] = useState(settings.policy.aiPaused)
  const [limits, setLimits] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      policyFields.map((field) => [
        field.key,
        String(settings.policy.limits[field.key] / field.factor),
      ]),
    ),
  )
  const [storageBudget, setStorageBudget] = useState(
    String(settings.storageBudgetBytes / 1073741824),
  )
  const save = useAdminSubmit(onSaved)
  function submit(event: FormEvent) {
    event.preventDefault()
    try {
      if (!/^(0|[1-9]\d*)(?:\.\d{1,6})?$/.test(budget)) throw new Error('invalid amount')
      const [whole, fraction = ''] = budget.split('.')
      const input = siteSettingsUpdateSchema.parse({
        expectedVersion: settings.version,
        storageBudgetBytes: Math.round(Number(storageBudget) * 1073741824),
        policy: {
          runContentDays: Number(days),
          userDailyTokens: Number(daily),
          monthlyMicroUsd: Number(
            BigInt(whole ?? '0') * 1_000_000n + BigInt(fraction.padEnd(6, '0')),
          ),
          aiPaused: paused,
          limits: Object.fromEntries(
            policyFields.map((field) => [
              field.key,
              Math.round(Number(limits[field.key]) * field.factor),
            ]),
          ),
        },
      })
      void save.submit('/api/admin/settings', input)
    } catch (error) {
      showToast(describeError(error))
    }
  }
  return (
    <form className="admin-form admin-policy" onSubmit={submit}>
      <Banner>{m.admin_policy_notice()}</Banner>
      <p>
        {settings.provider} · {settings.fastModel} · {settings.deepModel}
      </p>
      <TextField
        label={m.admin_retention()}
        hint={m.admin_retention_hint()}
        type="number"
        min={1}
        max={30}
        required
        value={days}
        onChange={(event) => setDays(event.currentTarget.value)}
      />
      <TextField
        label={m.admin_daily_tokens()}
        type="number"
        min={0}
        step={1}
        required
        value={daily}
        onChange={(event) => setDaily(event.currentTarget.value)}
      />
      <TextField
        label={m.admin_budget()}
        required
        inputMode="decimal"
        value={budget}
        onChange={(event) => setBudget(event.currentTarget.value)}
      />
      {policyFields.map((field) => (
        <TextField
          key={field.key}
          label={field.label()}
          type="number"
          min={0}
          step="any"
          required
          value={limits[field.key] ?? ''}
          onChange={(event) => setLimits({ ...limits, [field.key]: event.currentTarget.value })}
        />
      ))}
      <TextField
        label={m.admin_storage_budget()}
        hint={m.admin_storage_budget_hint()}
        type="number"
        min={0}
        step="any"
        required
        value={storageBudget}
        onChange={(event) => setStorageBudget(event.currentTarget.value)}
      />
      <Switch label={m.admin_pause_ai()} checked={paused} onCheckedChange={setPaused} />
      <p>{m.admin_pause_ai()}</p>
      <Button type="submit" busy={save.busy}>
        {m.common_save()}
      </Button>
    </form>
  )
}
function auditLabel(action: string) {
  const labels: Record<string, () => string> = {
    'user.ban': () => m.admin_ban(),
    'user.unban': () => m.admin_unban(),
    'user.limits': () => m.admin_limits(),
    'user.verify_email': () => m.admin_verify(),
    'invite.revoked': () => m.admin_revoke(),
    'conversation.archive': () => m.admin_archive(),
    'conversation.restore': () => m.admin_restore(),
    'member.unban': () => m.admin_unban(),
    'report.context.view': () => m.admin_open_context(),
    'report.handled': () => m.admin_resolve(),
    'settings.update': () => m.admin_policy(),
    'admin.agent_run_viewed': () => m.admin_run_content(),
  }
  return (labels[action] ?? (() => m.admin_audit_action()))()
}
/** Content view omits internal identifiers, binary image data and provider trace fields. React renders text safely. */
function readableContent(value: unknown): string {
  if (typeof value === 'string') return value.replace(/<@user:[^>]*>/gi, '@…')
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(readableContent).filter(Boolean).join('\n')
  if (typeof value !== 'object') return ''
  return Object.entries(value)
    .filter(
      ([key]) =>
        !/(id|hash|version|epoch|image|url|token|key|revision|index|createdAt|metadata)$/i.test(
          key,
        ),
    )
    .map(([, item]) => readableContent(item))
    .filter(Boolean)
    .join('\n')
}
