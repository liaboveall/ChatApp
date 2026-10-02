// A small syntax highlighter that stands in for Shiki (spec 5, which uses CSS-variable themes: the
// token classes below map to --code-* variables, so light and dark need no inline colours).

import { h } from './dom.js'

const LANGS = {
  sql: {
    ci: true,
    comment: '--[^\\n]*',
    kw: 'select|from|where|create|table|index|on|insert|into|values|alter|add|drop|primary|key|not|null|default|references|constraint|unique|using|order|by|limit|and|or|begin|commit|rollback|if|exists|set|update|delete|concurrently|cascade',
    types: 'uuid|text|bigint|integer|boolean|timestamptz|jsonb|bigserial',
  },
  ts: {
    comment: '//[^\\n]*|/\\*[\\s\\S]*?\\*/',
    kw: 'const|let|var|function|return|if|else|for|while|import|from|export|async|await|new|type|interface|extends|class|throw|try|catch|of|in|as|true|false|null|undefined',
    types: 'string|number|boolean|void|unknown|never|Promise|Record|Array|Date',
  },
  bash: {
    comment: '#[^\\n]*',
    kw: 'if|then|else|fi|for|do|done|echo|cd|export|sudo|git|bun|docker',
    types: '',
  },
  json: { comment: '(?!)', kw: 'true|false|null', types: '' },
}
LANGS.js = LANGS.ts
LANGS.typescript = LANGS.ts
LANGS.sh = LANGS.bash

const cache = new Map()
function grammar(name) {
  const lang = LANGS[name]
  if (!lang) return null
  if (!cache.has(name)) {
    const flags = lang.ci ? 'gi' : 'g'
    const source = [
      `(?<c>${lang.comment})`,
      '(?<s>"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)',
      '(?<n>\\b\\d+(?:\\.\\d+)?\\b)',
      '(?<w>[A-Za-z_][\\w]*)',
    ].join('|')
    cache.set(name, {
      re: new RegExp(source, flags),
      kw: new RegExp(`^(?:${lang.kw})$`, lang.ci ? 'i' : ''),
      types: lang.types ? new RegExp(`^(?:${lang.types})$`, lang.ci ? 'i' : '') : null,
    })
  }
  return cache.get(name)
}

/** Returns an array of text nodes and token spans for `code`. Unknown languages come back as plain text. */
export function highlight(code, langName = '') {
  const g = grammar(langName.toLowerCase())
  if (!g) return [code]
  const out = []
  let last = 0
  g.re.lastIndex = 0
  for (let m = g.re.exec(code); m; m = g.re.exec(code)) {
    if (m.index > last) out.push(code.slice(last, m.index))
    const text = m[0]
    let cls = null
    if (m.groups.c) cls = 'tok-c'
    else if (m.groups.s) cls = 'tok-s'
    else if (m.groups.n) cls = 'tok-n'
    else if (m.groups.w) {
      if (g.kw.test(text)) cls = 'tok-k'
      else if (g.types?.test(text)) cls = 'tok-t'
      else if (code[m.index + text.length] === '(') cls = 'tok-f'
    }
    out.push(cls ? h(`span.${cls}`, text) : text)
    last = m.index + text.length
    if (text.length === 0) g.re.lastIndex++
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}
