import type { Attachment } from '@chatapp/contracts'
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { IconButton } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { m } from '@/paraglide/messages.js'
import { ThumbImage } from './thumb-image.tsx'

export const byteLabel = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(2)} MiB`
function FileCard({ file }: { file: Attachment }) {
  return (
    <a className="file-card" href={file.urls.original} download={file.name}>
      <Download size={18} aria-hidden="true" />
      <span>
        <b>{file.name}</b>
        <small>{byteLabel(file.sizeBytes)}</small>
        {file.metadataCleared === false ? (
          <small role="note">{m.media_metadata_uncleared()}</small>
        ) : null}
      </span>
      <span className="sr-only">{m.media_download({ name: file.name })}</span>
    </a>
  )
}
function Playable({ file }: { file: Attachment }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <FileCard file={file} />
  const player =
    file.kind === 'video' ? (
      <video
        className="attachment-video"
        controls
        preload="metadata"
        src={file.urls.original}
        onError={() => setFailed(true)}
        aria-label={file.name}
      >
        <track kind="captions" />
      </video>
    ) : (
      // biome-ignore lint/a11y/useMediaCaption: user-uploaded audio has no transcript; controls and download remain available
      <audio
        className="attachment-audio"
        controls
        preload="metadata"
        src={file.urls.original}
        onError={() => setFailed(true)}
        aria-label={file.name}
      />
    )
  return (
    <div className="attachment-playable">
      {player}
      <FileCard file={file} />
    </div>
  )
}
export function Attachments({ files }: { files: Attachment[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  const images = files.filter((file) => file.kind === 'image')
  const index = images.findIndex((file) => file.id === selected),
    image = images[index]
  const move = (delta: number) => {
    const next = images[(index + delta + images.length) % images.length]
    if (next) setSelected(next.id)
  }
  useEffect(() => {
    if (selected && !files.some((file) => file.id === selected)) setSelected(null)
  }, [files, selected])
  useLayoutEffect(() => {
    if (!image) return
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setSelected(null)
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const next =
          images[(index + (event.key === 'ArrowLeft' ? -1 : 1) + images.length) % images.length]
        if (next) setSelected(next.id)
      }
    }
    document.addEventListener('keydown', key, true)
    return () => document.removeEventListener('keydown', key, true)
  }, [image, images, index])
  return (
    <div className="attachments">
      {images.length ? (
        <div className="attachment-grid">
          {images.map((file) => (
            <button
              type="button"
              className="attachment-image"
              key={file.id}
              onClick={() => setSelected(file.id)}
              aria-label={m.media_preview({ name: file.name })}
            >
              <ThumbImage file={file} />
            </button>
          ))}
        </div>
      ) : null}
      {files
        .filter((file) => file.kind !== 'image')
        .map((file) =>
          file.kind === 'video' || file.kind === 'audio' ? (
            <Playable key={file.id} file={file} />
          ) : (
            <FileCard key={file.id} file={file} />
          ),
        )}
      <Dialog
        open={!!image}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
        title={image?.name ?? ''}
        className="dialog--lightbox"
      >
        {image ? (
          <div className="lightbox">
            <img src={image.urls.preview ?? image.urls.original} alt={image.name} />
            <div className="lightbox__actions">
              <IconButton
                icon={ChevronLeft}
                label={m.media_previous()}
                disabled={images.length < 2}
                onClick={() => move(-1)}
              />
              <a className="btn btn--plain" href={image.urls.original} download={image.name}>
                {m.media_download({ name: image.name })}
              </a>
              <IconButton
                icon={ChevronRight}
                label={m.media_next()}
                disabled={images.length < 2}
                onClick={() => move(1)}
              />
              <IconButton icon={X} label={m.common_close()} onClick={() => setSelected(null)} />
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  )
}
