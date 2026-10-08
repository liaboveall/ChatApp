import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough'
import { cjkFriendlyExtension } from 'micromark-extension-cjk-friendly'
import { gfmStrikethroughCjkFriendly } from 'micromark-extension-cjk-friendly-gfm-strikethrough'

type Node = {
  type: string
  value?: string
  alt?: string | null
  url?: string
  children?: Node[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

const inlineParents = new Set(['paragraph', 'heading', 'strong', 'emphasis', 'delete', 'link'])
const blockParents = new Set(['root', 'blockquote', 'list', 'listItem'])

/**
 * Readable text for a compact preview, using the message renderer's Markdown subset and CJK emphasis rules.
 * Parse the full source once, before resolving mention names or truncating it. The result is already plain text:
 * parsing it again would reinterpret literal Markdown characters from code, escapes or people's display names.
 * No HTML is rendered, link destinations are discarded and images become their text labels.
 */
export function markdownPreviewText(source: string | null): string | null {
  if (source === null) return null
  const tree = fromMarkdown(source, {
    extensions: [cjkFriendlyExtension(), gfmStrikethroughCjkFriendly()],
    mdastExtensions: [gfmStrikethroughFromMarkdown()],
  })
  const parts: string[] = []
  // Iterate so deeply nested user input does not recurse through our projection.
  const pending: (Node | string)[] = [tree]
  while (pending.length > 0) {
    const node = pending.pop()
    if (node === undefined) continue
    if (typeof node === 'string') {
      parts.push(node)
    } else if (inlineParents.has(node.type) || blockParents.has(node.type)) {
      const children = node.children ?? []
      for (let i = children.length - 1; i >= 0; i--) {
        const child = children[i]
        if (!child) continue
        if (blockParents.has(node.type)) pending.push(' ')
        pending.push(child)
      }
    } else if (node.type === 'image') {
      parts.push(node.alt || node.url || '')
    } else if (node.type === 'break') {
      parts.push(' ')
    } else if (['text', 'inlineCode', 'code', 'html'].includes(node.type)) {
      parts.push(node.value ?? '')
    } else {
      // Rules, definitions and reference syntax are literal text in the message renderer too.
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) parts.push(source.slice(start, end))
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim()
}
