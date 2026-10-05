/**
 * `/join#<code>`: a group invitation link (docs/01 section 4.2, D-156). The code is read into memory at once and taken out
 * of the address bar; without a session it waits through the sign-in in this tab's session storage. With one, the page
 * shows what the link opens and joins on request. "Open" for someone who is already in goes through the same accept call
 * (it is idempotent) instead of only navigating. The server answers an unusable link the same way whatever is wrong with it.
 */
import type { ConversationInvitePreview } from '@chatapp/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { LinkIcon, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Avatar } from '@/components/ui/avatar.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/feedback.tsx'
import { AuthCard, AuthHead } from '@/features/auth/auth-layout.tsx'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { usePageTitle } from '@/lib/page-title.ts'
import { savePendingInvite, takePendingInvite } from '@/lib/pending-invite.ts'
import { meQuery } from '@/lib/queries.ts'
import { stripFragment } from '@/lib/url.ts'
import { m } from '@/paraglide/messages.js'
import { acceptInvite, previewInvite } from './api.ts'
import { joinErrorText } from './join-error.ts'

/** The code in the fragment: `#<code>`, or `#code=<code>` if a link was written that way. */
function codeFromHash(hash: string): string | null {
  const body = hash.replace(/^#/, '')
  const found = body.includes('=') ? new URLSearchParams(body).get('code') : body
  return found !== null && /^[A-Za-z0-9_-]{1,64}$/.test(found) ? found : null
}

export function JoinPage() {
  usePageTitle(m.join_title())
  const navigate = useNavigate()
  const me = useQuery(meQuery)
  // Read on the first render: from the fragment, or what the sign-in kept for this tab.
  const [code] = useState<string | null>(
    () => codeFromHash(window.location.hash) ?? takePendingInvite(),
  )
  const [preview, setPreview] = useState<ConversationInvitePreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => stripFragment(), [])

  const signedIn = me.data !== undefined && me.data !== null
  const signedOut = me.data === null
  useEffect(() => {
    if (code === null || !signedOut) return
    // Not signed in: keep the code through the sign-in and come back here.
    savePendingInvite(code)
    void navigate({ to: '/login', search: { redirect: '/join' }, replace: true })
  }, [code, signedOut, navigate])

  useEffect(() => {
    if (code === null || !signedIn) return
    let live = true
    previewInvite(code)
      .then((found) => live && setPreview(found))
      .catch((error: unknown) => live && setProblem(joinErrorText(error) ?? describeError(error)))
    return () => {
      live = false
    }
  }, [code, signedIn])

  const join = async (): Promise<void> => {
    if (code === null) return
    setBusy(true)
    try {
      const conversation = await acceptInvite(code)
      await navigate({ to: '/c/$conversationId', params: { conversationId: conversation.id } })
    } catch (error) {
      setProblem(
        error instanceof ApiError && error.code === 'CONVERSATION_BANNED'
          ? m.join_banned_removed()
          : (joinErrorText(error) ?? describeError(error)),
      )
      setBusy(false)
    }
  }

  if (code === null) {
    return (
      <AuthCard>
        <AuthHead
          icon={TriangleAlert}
          tone="bad"
          title={m.join_title()}
          text={m.join_invite_invalid()}
        />
        <Link to="/" className="btn btn--filled btn--lg btn--block no-underline">
          {m.not_found_action()}
        </Link>
      </AuthCard>
    )
  }
  if (problem !== null) {
    return (
      <AuthCard>
        <AuthHead icon={TriangleAlert} tone="bad" title={m.join_title()} text={problem} />
        <Link to="/" className="btn btn--filled btn--lg btn--block no-underline">
          {m.not_found_action()}
        </Link>
      </AuthCard>
    )
  }
  if (preview === null) {
    return (
      <AuthCard>
        <div className="grid place-items-center py-10">
          <Spinner label={m.common_loading()} />
        </div>
      </AuthCard>
    )
  }
  return (
    <AuthCard>
      <AuthHead icon={LinkIcon} title={m.join_title()} text={m.join_lead()} />
      <div className="join-preview">
        <Avatar name={preview.name} seed={preview.name} size={56} />
        <h2 className="text-title-2">{preview.name}</h2>
        {preview.description ? <p className="join-preview__text">{preview.description}</p> : null}
        <p className="join-preview__meta">
          {m.toolbar_member_count({ count: preview.memberCount })}
        </p>
      </div>
      <Button kind="filled" size="lg" block busy={busy} onClick={() => void join()}>
        {preview.alreadyMember ? m.join_open() : m.discovery_join()}
      </Button>
    </AuthCard>
  )
}
