// The Markdown subset of docs/01 section 4.5: bold, italic, strikethrough, inline code, fenced code
// with language highlighting, links (http, https, mailto only), ordered and unordered lists, quotes.
// No headings, images or raw HTML: everything else is plain text. Unfinished markers stay literal, so
// text that is still streaming never renders half-formatted (what Streamdown does in the real app).

import { copyText, h, icon } from './dom.js'
import { highlight } from './highlight.js'

const SAFE_LINK = /^(https?:\/\/|mailto:)/i

function link(href, children) {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, children)
}

const RULES = [
  { re: /`([^`\n]+)`/y, build: (m) => h('code', m[1]) },
  { re: /<@user:([\w-]+)>/y, build: (m, ctx) => ctx.mention?.(m[1]) ?? `@${m[1]}` },
  {
    re: /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/y,
    build: (m, ctx) => (SAFE_LINK.test(m[2]) ? link(m[2], parseInline(m[1], ctx)) : m[0]),
  },
  { re: /\*\*(?=\S)([^\n]+?)\*\*/y, build: (m, ctx) => h('strong', parseInline(m[1], ctx)) },
  { re: /~~(?=\S)([^\n]+?)~~/y, build: (m, ctx) => h('s', parseInline(m[1], ctx)) },
  { re: /\*(?=[^\s*])([^*\n]+?)\*/y, build: (m, ctx) => h('em', parseInline(m[1], ctx)) },
  {
    // The URL ends at the first non-ASCII character: CJK text and full-width punctuation stop it.
    re: /https?:\/\/[\x21-\x7E]+/y,
    build: (m) => {
      const url = m[0].replace(/[.,;:!?)\]}'"*]+$/, '')
      return { node: link(url, url), length: url.length }
    },
  },
]

const NEXT_SPECIAL = /[`<[*~h]/g

export function parseInline(text, ctx = {}) {
  const out = []
  let buffer = ''
  let i = 0
  const flush = () => {
    if (buffer) {
      out.push(buffer)
      buffer = ''
    }
  }
  while (i < text.length) {
    let matched = false
    for (const rule of RULES) {
      rule.re.lastIndex = i
      const m = rule.re.exec(text)
      if (!m) continue
      const built = rule.build(m, ctx)
      if (typeof built === 'string' && built === m[0]) continue
      flush()
      if (built && typeof built === 'object' && 'node' in built) {
        out.push(built.node)
        i += built.length
      } else {
        out.push(built)
        i += m[0].length
      }
      matched = true
      break
    }
    if (matched) continue
    NEXT_SPECIAL.lastIndex = i + 1
    const next = NEXT_SPECIAL.exec(text)
    const stop = next ? next.index : text.length
    buffer += text.slice(i, stop)
    i = stop
  }
  flush()
  return out
}

export function codeBlock(lang, body) {
  const label = h('span', lang ? lang.toUpperCase() : '代码')
  const button = h(
    'button.btn.btn--plain.btn--sm',
    {
      type: 'button',
      'aria-label': '复制代码',
      onclick: () => {
        copyText(body).then(() => {
          button.replaceChildren(icon('check', 16), '已复制')
          setTimeout(() => button.replaceChildren(icon('copy', 16), '复制'), 1500)
        })
      },
    },
    icon('copy', 16),
    '复制',
  )
  return h(
    'div.code',
    h('div.code__head', label, button),
    h('pre', { tabindex: '0' }, h('code', highlight(body, lang))),
  )
}

const BLOCK_START = /^(```|>\s?|\s*[-*•]\s+|\s*\d+[.)]\s+)/

export function renderMarkdown(source, ctx = {}) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const nodes = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^```([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence, or the end of text while streaming
      nodes.push(codeBlock(fence[1], body.join('\n')))
      continue
    }
    if (/^>\s?/.test(line)) {
      const quoted = []
      while (i < lines.length && /^>\s?/.test(lines[i]))
        quoted.push(lines[i++].replace(/^>\s?/, ''))
      nodes.push(h('blockquote', h('p', parseInline(quoted.join('\n'), ctx))))
      continue
    }
    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const itemRe = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/
      const items = []
      while (i < lines.length && itemRe.test(lines[i])) {
        items.push(h('li', parseInline(lines[i].replace(itemRe, ''), ctx)))
        i++
      }
      nodes.push(h(ordered ? 'ol' : 'ul', items))
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !(para.length > 0 && BLOCK_START.test(lines[i]))
    ) {
      para.push(lines[i++])
    }
    nodes.push(h('p', parseInline(para.join('\n'), ctx)))
  }
  return nodes
}
