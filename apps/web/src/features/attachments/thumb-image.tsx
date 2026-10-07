import type { Attachment } from '@chatapp/contracts'
import { useEffect, useRef, useState } from 'react'
import { thumbHashToRGBA } from 'thumbhash'

/** The hash is a tiny pixel placeholder; it never downloads or decodes the original upload. */
export function ThumbImage({ file }: { file: Attachment }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!file.thumbhash || !canvas.current) return
    try {
      const hash = Uint8Array.from(atob(file.thumbhash), (char) => char.charCodeAt(0))
      const { w, h, rgba } = thumbHashToRGBA(hash)
      const element = canvas.current
      element.width = w
      element.height = h
      element.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0)
    } catch {
      /* An invalid old hash keeps the neutral placeholder. */
    }
  }, [file.thumbhash])
  return (
    <>
      <canvas
        ref={canvas}
        className="attachment-placeholder"
        tabIndex={-1}
        aria-hidden="true"
        hidden={loaded || !file.thumbhash}
      />
      <img
        src={file.urls.thumb ?? file.urls.original}
        alt={file.name}
        width={file.width ?? undefined}
        height={file.height ?? undefined}
        loading="lazy"
        onLoad={() => setLoaded(true)}
      />
    </>
  )
}
