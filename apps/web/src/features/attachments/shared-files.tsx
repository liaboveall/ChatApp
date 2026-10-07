import { type AttachmentPage, attachmentPageSchema, type Conversation } from '@chatapp/contracts'
import { useEffect, useRef, useState } from 'react'
import { forScreen } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { useTimelineWindow } from '@/lib/sync/hooks.ts'
import { m } from '@/paraglide/messages.js'
import { Attachments } from './gallery.tsx'

export function SharedFiles({ conversation }: { conversation: Conversation }) {
  const [kind, setKind] = useState(''),
    [page, setPage] = useState<AttachmentPage>({ items: [], nextCursor: null })
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const requests = useRef<AbortController | null>(null)
  const pages = useRef(1)
  const previousRevision = useRef<string | null>(null)
  const window = useTimelineWindow(conversation.id)
  const attachmentRevision = JSON.stringify([
    window?.messages
      .filter((message) => message.attachments.length)
      .map((message) => message.attachments.map((file) => [file.id, file.version])),
    window?.hidden,
    window?.gone,
  ])
  const load = async (signal: AbortSignal, cursor?: string, count = 1) => {
    setBusy(true)
    setError('')
    try {
      let result = await forScreen(conversation.id, () =>
        api(
          `/api/conversations/${conversation.id}/attachments?limit=30${kind ? `&kind=${kind}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          { schema: attachmentPageSchema, signal },
        ),
      )
      if (result && !cursor) {
        const items = [...result.items]
        for (let index = 1; index < count && result.nextCursor && !signal.aborted; index++) {
          const next = await forScreen(conversation.id, () =>
            api(
              `/api/conversations/${conversation.id}/attachments?limit=30${kind ? `&kind=${kind}` : ''}&cursor=${encodeURIComponent(result?.nextCursor ?? '')}`,
              { schema: attachmentPageSchema, signal },
            ),
          )
          if (!next) return
          items.push(...next.items)
          result = next
        }
        result = { items, nextCursor: result.nextCursor }
      }
      if (result && !signal.aborted) {
        if (cursor) pages.current++
        setPage((old) => ({
          items: cursor ? [...old.items, ...result.items] : result.items,
          nextCursor: result.nextCursor,
        }))
        setBusy(false)
      }
    } catch (error) {
      if (!signal.aborted) {
        setError(describeError(error))
        setBusy(false)
      }
    }
  }
  // Membership, hidden marks and recalls rebuild this listing; an older page is cancelled before reuse.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the listed entity versions are the reload boundary
  useEffect(() => {
    const controller = new AbortController()
    setPage({ items: [], nextCursor: null })
    pages.current = 1
    requests.current = controller
    void load(controller.signal)
    return () => {
      controller.abort()
      requests.current = null
    }
  }, [conversation.id, conversation.me?.membershipId, kind])
  // Text-only messages do not touch this listing. Refreshes keep the number of loaded pages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only accepted attachment changes invalidate loaded pages
  useEffect(() => {
    if (previousRevision.current === null) {
      previousRevision.current = attachmentRevision
      return
    }
    previousRevision.current = attachmentRevision
    requests.current?.abort()
    const controller = new AbortController()
    requests.current = controller
    void load(controller.signal, undefined, pages.current)
    return () => controller.abort()
  }, [attachmentRevision, conversation.viewerVersion])
  if (!conversation.me) return null
  return (
    <section className="dsec shared-files">
      <h2 className="dsec__title">{m.media_files()}</h2>
      <select
        className="select"
        aria-label={m.media_files()}
        value={kind}
        onChange={(event) => setKind(event.target.value)}
      >
        <option value="">{m.media_filter_all()}</option>
        <option value="image">{m.media_filter_image()}</option>
        <option value="video">{m.media_filter_video()}</option>
        <option value="audio">{m.media_filter_audio()}</option>
        <option value="file">{m.media_filter_file()}</option>
      </select>
      {error ? <p role="alert">{error}</p> : null}
      {!busy && !error && !page.items.length ? (
        <p className="dsec__note">{m.media_empty()}</p>
      ) : null}
      <Attachments
        files={page.items
          .filter(
            (item) =>
              !window?.hidden[item.messageId] &&
              !window?.gone[item.messageId] &&
              !window?.messages.some(
                (message) =>
                  message.id === item.messageId && (message.recalledAt || message.deletedAt),
              ),
          )
          .map((item) => item.attachment)}
      />
      {page.nextCursor ? (
        <Button
          size="sm"
          busy={busy}
          onClick={() => {
            const signal = requests.current?.signal
            if (signal && !signal.aborted) void load(signal, page.nextCursor ?? undefined)
          }}
        >
          {m.media_more()}
        </Button>
      ) : null}
    </section>
  )
}
