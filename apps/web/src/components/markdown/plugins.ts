/**
 * The remark plugins of the one safe renderer (docs/01 section 4.5, D-145). They run after remark-gfm, on the markdown
 * syntax tree, and write plain data back: no HTML is ever produced here.
 *
 *  - `cjkAutolinkBoundary`: an automatically recognised link ends at the first CJK character or full-width punctuation.
 *  - `restrictToSubset`: only the node types the product allows survive; the rest is shown as the text the person typed.
 *  - `softBreaks`: a single line break inside a paragraph is a line break (Shift+Enter in the composer).
 */

export type MdNode = {
  type: string
  url?: string
  value?: string
  checked?: boolean | null
  depth?: number
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

type SourceFile = { value?: unknown }

// CJK ideographs (and extensions A, compatibility), kana, hangul, CJK symbols and punctuation, full-width forms.
const CJK = /[⺀-⿿　-〿぀-ヿ㄀-ㄯ㄰-㆏ㆠ-ㇿ㈀-㏿㐀-䶿一-鿿ꥠ-꥿가-힯豈-﫿︰-﹏＀-￯]/u

/**
 * An autolink literal is a link whose only child is text equal to its address. It is cut at the first CJK character or
 * full-width punctuation, and the rest becomes plain text again; one that starts with such a character is not a link.
 */
export function cjkAutolinkBoundary(): (tree: MdNode) => void {
  const visit = (node: MdNode): void => {
    const children = node.children
    if (!children) return
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      if (!child) continue
      if (
        child.type === 'link' &&
        child.children?.length === 1 &&
        child.children[0]?.type === 'text' &&
        typeof child.url === 'string'
      ) {
        const label = child.children[0].value ?? ''
        const autolink =
          label === child.url || `mailto:${label}` === child.url || `http://${label}` === child.url
        const cut = label.search(CJK)
        if (autolink && cut > 0) {
          const tail = label.slice(cut)
          const url = child.url.slice(0, child.url.length - tail.length)
          children.splice(
            index,
            1,
            { ...child, url, children: [{ type: 'text', value: label.slice(0, cut) }] },
            { type: 'text', value: tail },
          )
          index += 1
          continue
        }
        if (autolink && cut === 0) {
          children.splice(index, 1, { type: 'text', value: label })
          continue
        }
      }
      visit(child)
    }
  }
  return (tree) => visit(tree)
}

/** The node types the product renders (docs/01 section 4.5): everything else is text. Default is "no". */
const ALLOWED = new Set([
  'root',
  'paragraph',
  'text',
  'strong',
  'emphasis',
  'delete',
  'inlineCode',
  'code',
  'link',
  'list',
  'listItem',
  'blockquote',
  'break',
  // Allowed here, rendered as a link by the `img` component: the page policy loads no outside pictures.
  'image',
])

/** Where a replacement is a whole block (a paragraph) rather than a stretch of text inside one. */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem'])

function sourceOf(node: MdNode, source: string): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (typeof start === 'number' && typeof end === 'number') return source.slice(start, end)
  return node.value ?? ''
}

function restrict(parent: MdNode, source: string): void {
  const children = parent.children
  if (!children) return
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (!child) continue
    if (child.type === 'heading') {
      // A heading is an ordinary paragraph with the same words.
      child.type = 'paragraph'
      child.depth = undefined
    } else if (!ALLOWED.has(child.type)) {
      // Tables, rules, footnotes, definitions and references, raw HTML, anything a newer plugin invents: the typed text.
      const text = sourceOf(child, source)
      children[index] = BLOCK_PARENTS.has(parent.type)
        ? { type: 'paragraph', children: [{ type: 'text', value: text }] }
        : { type: 'text', value: text }
      continue
    }
    if (child.type === 'listItem' && child.checked !== undefined && child.checked !== null) {
      const marker = child.checked ? '[x] ' : '[ ] '
      const first = child.children?.[0]
      if (first?.type === 'paragraph') {
        first.children = [{ type: 'text', value: marker }, ...(first.children ?? [])]
      } else {
        child.children = [
          { type: 'paragraph', children: [{ type: 'text', value: marker.trimEnd() }] },
          ...(child.children ?? []),
        ]
      }
      child.checked = null
    }
    restrict(child, source)
  }
}

export function restrictToSubset(): (tree: MdNode, file: SourceFile) => void {
  return (tree, file) => restrict(tree, typeof file.value === 'string' ? file.value : '')
}

/** Splits text at line breaks into text and `break` nodes (code, which has no text children, is left alone). */
export function softBreaks(): (tree: MdNode) => void {
  const visit = (node: MdNode): void => {
    const children = node.children
    if (!children) return
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      if (!child) continue
      if (child.type === 'text' && child.value?.includes('\n')) {
        const replacement: MdNode[] = []
        child.value.split('\n').forEach((part, position) => {
          if (position > 0) replacement.push({ type: 'break' })
          if (part !== '') replacement.push({ type: 'text', value: part })
        })
        children.splice(index, 1, ...replacement)
        index += replacement.length - 1
      } else {
        visit(child)
      }
    }
  }
  return (tree) => visit(tree)
}
