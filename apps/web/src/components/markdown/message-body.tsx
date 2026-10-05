import { memo } from 'react'
import { markdownRenderer } from './lazy.ts'

/**
 * The text of one message. Memoized on the text itself: a row that re-renders because something around it changed does not
 * parse and highlight its Markdown again. The renderer must be loaded (screens wait for it before they build a list).
 */
export const MessageBody = memo(function MessageBody({ text }: { text: string }) {
  const Renderer = markdownRenderer()
  return <div className="md">{Renderer ? <Renderer mode="static">{text}</Renderer> : text}</div>
})
