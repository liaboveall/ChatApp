import {
  type Conversation,
  conversationSchema,
  type Me,
  meSchema,
  UPLOAD_LIMITS,
} from '@chatapp/contracts'
import { useEffect, useRef, useState } from 'react'
import { engine, forScreen } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { api } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { m } from '@/paraglide/messages.js'
import { uploadFile } from './upload.ts'

function Crop({
  file,
  onSave,
  onCancel,
  busy,
}: {
  file: File
  onSave: (blob: Blob) => void
  onCancel: () => void
  busy: boolean
}) {
  const [url, setUrl] = useState(''),
    [zoom, setZoom] = useState(1),
    [x, setX] = useState(0),
    [y, setY] = useState(0)
  const [ready, setReady] = useState(false)
  const [dimensions, setDimensions] = useState({ width: 256, height: 256 })
  const side = Math.min(dimensions.width, dimensions.height) / zoom
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const value = URL.createObjectURL(file)
    setUrl(value)
    return () => URL.revokeObjectURL(value)
  }, [file])
  const save = () => {
    const element = image.current
    if (!element?.naturalWidth) return
    const side = Math.min(element.naturalWidth, element.naturalHeight) / zoom
    const canvas = document.createElement('canvas')
    canvas.width = 512
    canvas.height = 512
    canvas
      .getContext('2d')
      ?.drawImage(
        element,
        ((element.naturalWidth - side) * (x + 1)) / 2,
        ((element.naturalHeight - side) * (y + 1)) / 2,
        side,
        side,
        0,
        0,
        512,
        512,
      )
    canvas.toBlob((blob) => {
      if (blob) onSave(blob)
    }, 'image/png')
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
      title={m.media_crop()}
    >
      <div className="avatar-crop">
        <img
          ref={image}
          src={url || undefined}
          alt={file.name}
          onLoad={(event) => {
            setDimensions({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
            setReady(true)
          }}
          style={{
            width: (dimensions.width / side) * 256,
            height: (dimensions.height / side) * 256,
            left: (-((dimensions.width / side) * 256 - 256) * (x + 1)) / 2,
            top: (-((dimensions.height / side) * 256 - 256) * (y + 1)) / 2,
          }}
        />
      </div>
      <label>
        {m.media_zoom()}
        <input
          type="range"
          min="1"
          max="4"
          step="0.05"
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        />
      </label>
      <label>
        {m.media_position_x()}
        <input
          type="range"
          min="-1"
          max="1"
          step="0.05"
          value={x}
          onChange={(event) => setX(Number(event.target.value))}
        />
      </label>
      <label>
        {m.media_position_y()}
        <input
          type="range"
          min="-1"
          max="1"
          step="0.05"
          value={y}
          onChange={(event) => setY(Number(event.target.value))}
        />
      </label>
      <div className="dialog__actions">
        <Button kind="plain" disabled={busy} onClick={onCancel}>
          {m.common_cancel()}
        </Button>
        <Button busy={busy} disabled={!ready} onClick={save}>
          {m.common_save()}
        </Button>
      </div>
    </Dialog>
  )
}
export function AvatarEditor({ me, conversation }: { me: Me; conversation?: Conversation }) {
  const input = useRef<HTMLInputElement>(null),
    controller = useRef<AbortController | null>(null)
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  useEffect(() => () => controller.current?.abort(), [])
  const started = useRef(engine.ticket(conversation?.id ?? null))
  const set = async (attachmentId: string | null) => {
    if (!engine.isCurrent(started.current)) return null
    const scope = conversation?.id ?? null
    if (conversation) {
      const current = await forScreen(
        scope,
        () => api(`/api/conversations/${scope}`, { schema: conversationSchema }),
        (answer, ticket) => engine.ingestConversation(answer, ticket),
      )
      if (!current || !engine.isCurrent(started.current)) return null
      return forScreen(
        scope,
        () =>
          api(`/api/conversations/${scope}/avatar`, {
            method: 'POST',
            json: { attachmentId, expectedVersion: current.metadataVersion },
            schema: conversationSchema,
          }),
        (answer, ticket) => engine.ingestConversation(answer, ticket),
      )
    }
    const current = await forScreen(
      null,
      () => api('/api/me', { schema: meSchema }),
      (answer, ticket) => engine.ingestMe(answer, ticket),
    )
    if (!current || !engine.isCurrent(started.current)) return null
    return forScreen(
      null,
      () =>
        api('/api/me/avatar', {
          method: 'POST',
          json: { attachmentId, expectedVersion: current.meVersion },
          schema: meSchema,
        }),
      (answer, ticket) => engine.ingestMe(answer, ticket),
    )
  }
  const save = async (blob: Blob) => {
    if (!engine.isCurrent(started.current)) return
    setBusy(true)
    setError('')
    const abort = new AbortController()
    controller.current = abort
    try {
      const attachment = await uploadFile(
        blob,
        {
          purpose: conversation ? 'conversation_avatar' : 'avatar',
          name: 'avatar.png',
          ...(conversation ? { conversationId: conversation.id } : {}),
        },
        abort.signal,
        () => undefined,
      )
      if (!attachment || abort.signal.aborted) return
      if ((await set(attachment.id)) === null || abort.signal.aborted) return
      setFile(null)
      setBusy(false)
    } catch (error) {
      if (!abort.signal.aborted) {
        setError(describeError(error))
        setBusy(false)
      }
    }
  }
  return (
    <div className="avatar-editor">
      <input
        ref={input}
        type="file"
        className="sr-only"
        accept="image/jpeg,image/png,image/gif,image/webp,image/avif"
        aria-label={m.media_avatar()}
        tabIndex={-1}
        onChange={(event) => {
          const selected = event.target.files?.[0]
          if (selected) {
            if (selected.size > UPLOAD_LIMITS.imageBytes) setError(m.media_too_large())
            else setFile(selected)
          }
          event.target.value = ''
        }}
      />
      <Button size="sm" kind="plain" disabled={busy} onClick={() => input.current?.click()}>
        {m.media_avatar()}
      </Button>
      <Button
        size="sm"
        kind="plain"
        disabled={busy || !(conversation ? conversation.avatarUrl : me.avatarUrl)}
        onClick={() => {
          void set(null).catch((error) => setError(describeError(error)))
        }}
      >
        {m.media_avatar_clear()}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {file ? (
        <Crop
          file={file}
          busy={busy}
          onSave={(blob) => void save(blob)}
          onCancel={() => setFile(null)}
        />
      ) : null}
    </div>
  )
}
