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
  error,
}: {
  file: File
  onSave: (blob: Blob) => void
  onCancel: () => void
  busy: boolean
  error: string
}) {
  const [url, setUrl] = useState(''),
    [zoom, setZoom] = useState(1),
    [x, setX] = useState(0),
    [y, setY] = useState(0)
  const [ready, setReady] = useState(false)
  const [dimensions, setDimensions] = useState({ width: 256, height: 256 })
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{
    pointer: number
    clientX: number
    clientY: number
    x: number
    y: number
  } | null>(null)
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
      <p className="dsec__note">{m.media_crop_drag()}</p>
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        className="avatar-crop"
        aria-label={m.media_crop_drag()}
        disabled={!ready || busy}
        data-dragging={dragging}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = {
            pointer: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            x,
            y,
          }
          setDragging(true)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (!start || event.pointerId !== start.pointer) return
          const horizontal = (dimensions.width / side) * 256 - 256
          const vertical = (dimensions.height / side) * 256 - 256
          const clamp = (value: number) => Math.max(-1, Math.min(1, value))
          if (horizontal > 0)
            setX(clamp(start.x - (2 * (event.clientX - start.clientX)) / horizontal))
          if (vertical > 0) setY(clamp(start.y - (2 * (event.clientY - start.clientY)) / vertical))
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointer !== event.pointerId) return
          drag.current = null
          setDragging(false)
          event.currentTarget.releasePointerCapture(event.pointerId)
        }}
        onPointerCancel={() => {
          drag.current = null
          setDragging(false)
        }}
        onLostPointerCapture={() => {
          drag.current = null
          setDragging(false)
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.2 : 0.05
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            setX((value) =>
              Math.max(-1, Math.min(1, value + (event.key === 'ArrowRight' ? step : -step))),
            )
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            setY((value) =>
              Math.max(-1, Math.min(1, value + (event.key === 'ArrowDown' ? step : -step))),
            )
          }
        }}
      >
        <img
          ref={image}
          src={url || undefined}
          alt={file.name}
          draggable={false}
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
      </button>
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
    } catch (error) {
      if (!abort.signal.aborted) {
        setError(describeError(error))
      }
    } finally {
      if (controller.current === abort && !abort.signal.aborted) setBusy(false)
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
      {error && !file ? <p role="alert">{error}</p> : null}
      {file ? (
        <Crop
          file={file}
          busy={busy}
          error={error}
          onSave={(blob) => void save(blob)}
          onCancel={() => setFile(null)}
        />
      ) : null}
    </div>
  )
}
