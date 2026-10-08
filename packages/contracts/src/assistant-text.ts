/** Presentation cleanup for assistant citations, including answers created before the readable-citation prompt. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const IDENTIFIER = `(?:${UUID}|(?=[0-9a-f-]*[a-f])(?:[0-9a-f]{8}(?:-[0-9a-f]{0,4}){0,4}(?:\\.\\.\\.|…)?|[0-9a-f]{2,7}(?:\\.\\.\\.|…)))`
const ID_LABEL =
  '(?:\\bmessage[_ ]?id\\b|消息\\s*(?:ID|编号|序号)?|(?:完整\\s*)?\\bID\\b|来源|依据|引用|以工具返回为准|工具(?:返回的?|记录)|实际返回值(?:为)?|(?:更正\\s*[:：]\\s*)?逐字核对为|更正\\s*[:：]|需?核对为|原文应为|应逐字为|之前原文为|重新逐字给出|前一条|负责人|上线(?:日期与时间|日期|时间)|预算|是否延期|[—–]{1,2}\\s*(?:[,，]\\s*)?(?:即\\s*)?)'
// A comma after a sequence may introduce a source timestamp, rather than another internal number.
const NUMBER =
  '(?!\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}:\\d{2})\\d+(?:\\s*[-–—~至]\\s*\\d+)?(?![\\d:/-])'
const REFERENCE_VALUE = `(?:${UUID}|${NUMBER})`
const REFERENCE = new RegExp(
  `(?:\\bseq\\b|\\bmessage[_ ]?id\\b|消息\\s*(?:ID|编号|序号))\\s*[:：=#]?\\s*${REFERENCE_VALUE}(?:[ \\t]*[,，、][ \\t]*(?:\\bseq\\b[ \\t]*)?${REFERENCE_VALUE})*`,
  'gi',
)
// List separators stay on one line, so the next line's list number is never taken for a sequence.
// A reference used as a noun ("seq 99 的消息", "seq 92 中…", "消息 ID 92 条") keeps the sentence readable once it is gone.
const REFERENCE_PHRASE = new RegExp(
  `[ \\t]*${REFERENCE.source}(?:\\s*(的消息|的|条|中(?=[“"「包含有一的，,：:])))?[ \\t]*`,
  'gi',
)
const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef“”‘’]/
// Inside a timestamped citation, a bare "消息 92" is the internal sequence rather than a count.
const CITATION_SEQUENCE =
  /(?:^|[,，、;；])\s*消息\s*\d{1,4}(?:\s*[-–—~至]\s*\d{1,4})?\s*(?=$|[,，、;；])/g

function dropReferences(text: string): string {
  return text.replace(
    REFERENCE_PHRASE,
    (match: string, tail: string | undefined, offset: number) => {
      const lead = /^[ \t]*/.exec(match)?.[0] ?? ''
      const before = text[offset - 1]
      const after = text[offset + match.length]
      const noun = tail === '的消息' ? '相关消息' : tail === '中' ? '会话中' : ''
      if (before === undefined || before === '\n') return lead + noun
      if (noun || !lead) return noun
      // Keep one space only where the reference separated words that are not both Chinese.
      return CJK.test(before) && (after === undefined || after === '\n' || CJK.test(after))
        ? ''
        : ' '
    },
  )
}
const UUID_REFERENCE = new RegExp(
  `${ID_LABEL}\\s*(?:应?为)?\\s*(?:\\*{1,2})?[:：=#]?\\s*(?:\\*{1,2})?${IDENTIFIER}(?![0-9a-f-])(?:\\*{1,2})?(?:\\s*即\\s*${IDENTIFIER}(?![0-9a-f-]))?`,
  'gi',
)
// A citation that ended its line takes the separator before it, so no dangling comma remains.
const UUID_REFERENCE_AT_LINE_END = new RegExp(
  `[ \\t]*[,，、;；][ \\t]*(?:${UUID_REFERENCE.source})(?=[ \\t]*$)`,
  'gim',
)
const REFERENCE_PREFIX = new RegExp(
  `(?:(?:\\bseq\\b|${ID_LABEL})\\s*(?:应?为)?\\s*[:：=#]?\\s*|(?:${REFERENCE.source}|${UUID_REFERENCE.source})\\s*(?:即|[,，、])\\s*)$`,
  'i',
)
const NUMBER_REFERENCE_PREFIX =
  /(?:\bseq\b|\bmessage[_ ]?id\b|消息\s*(?:ID|编号|序号)|(?:完整\s*)?\bID\b)\s*[:：=#]?\s*$/i
const INLINE_REFERENCE = new RegExp(`^\x60(${IDENTIFIER}|${NUMBER})\x60$`, 'i')
const EXAMPLE_PREFIX = /(?:示例|例子|字面|literal|example|\b(?:const|let|var|UUID)\b)[^\n]{0,80}$/i
const CITATION_BRACKETS: Record<string, string> = { '(': ')', '（': '）', '[': ']', '〔': '〕' }
const MARKDOWN_LITERAL =
  /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|!?\[[^\n]*?\]\([^\n)]*\))/g
const UUID_CITATION = new RegExp(
  `^[\\s,，、;；]*${IDENTIFIER}(?:[\\s,，、;；]+${IDENTIFIER})*[\\s,，、;；]*$`,
  'i',
)
const CITATION_TIME = '(?:\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{1,2}:\\d{2}(?:\\s*UTC)?'
const UUID_BEFORE_TIME = new RegExp(`^\\s*${IDENTIFIER}\\s*[,，]\\s*(?=${CITATION_TIME}\\s*$)`, 'i')
const TABLE_CITATION = new RegExp(`^\x60?(?:${IDENTIFIER}|${NUMBER})\x60?(?![0-9a-f-])\\s*`, 'i')
const TABLE_SOURCE_ID = new RegExp(`^\x60?${IDENTIFIER}\x60?(?![0-9a-f-])\\s*`, 'i')
const TABLE_SOURCE_TAIL = new RegExp(`[,，、;；]\\s*\x60?${UUID}\x60?\\s*$`, 'i')

function hideCitationColumns(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g)
    .map((part, index) => {
      if (index % 2) return part
      return part.replace(
        /(^|\n)([ \t]*\|[^\n]+\|\n[ \t]*\|[-: |]+\|(?:\n[ \t]*\|[^\n]*\|)+)/g,
        (original, before: string, table: string, offset: number) => {
          if (EXAMPLE_PREFIX.test(part.slice(Math.max(0, offset - 80), offset).trimEnd()))
            return original
          const rows = table.split('\n').map((line) =>
            line
              .trim()
              .slice(1, -1)
              .split('|')
              .map((cell) => cell.trim()),
          )
          const header = rows[0] ?? []
          if (rows.some((row) => row.length !== header.length)) return original
          const columns = header.flatMap((cell, column) => {
            const title = cell.replaceAll('*', '')
            const internal = /^(?:(?:来源)?消息\s*(?:ID|编号|序号)|message[_ ]?id|seq)$/i.test(
              title,
            )
            const source = /^(?:来源(?:消息)?|依据|引用|source)(?:[（(].*[）)])?$/i.test(title)
            if (!internal && !source) return []
            const prefix = internal ? TABLE_CITATION : TABLE_SOURCE_ID
            return rows
              .slice(2)
              .some(
                (row) =>
                  prefix.test(row[column] ?? '') || TABLE_SOURCE_TAIL.test(row[column] ?? ''),
              )
              ? [{ column, prefix }]
              : []
          })
          const hidden = new Set<number>()
          for (const { column, prefix } of columns) {
            for (const row of rows.slice(2))
              row[column] = (row[column] ?? '')
                .replace(prefix, '')
                .replace(TABLE_SOURCE_TAIL, '')
                .trim()
            if (rows.slice(2).every((row) => !row[column])) hidden.add(column)
            else header[column] = '来源'
          }
          if (!columns.length || hidden.size === header.length) return original
          return (
            before +
            rows
              .map((row) => `| ${row.filter((_, column) => !hidden.has(column)).join(' | ')} |`)
              .join('\n')
          )
        },
      )
    })
    .join('')
}

export function assistantText(text: string): string {
  // Structured answers and literal code are content, rather than prose citations.
  if (/^\s*[{[]/.test(text)) {
    try {
      JSON.parse(text)
      return text
    } catch {
      /* Markdown prose. */
    }
  }
  // A prose citation stays a citation when a model wraps just its identifier in backticks.
  // Unquote only identifiers after an explicit reference label; ordinary code examples stay literal.
  const prose = hideCitationColumns(text)
    .split(MARKDOWN_LITERAL)
    .map((part, index, parts) => {
      if (!(index % 2)) return part
      const reference = INLINE_REFERENCE.exec(part)?.[1]
      const prefix = parts
        .slice(0, index)
        .join('')
        .replace(/\*{1,2}|`/g, '')
      if (!reference || EXAMPLE_PREFIX.test(prefix)) return part
      const open = /([（([〔])\s*$/.exec(prefix)?.[1]
      const close = open ? CITATION_BRACKETS[open] : undefined
      const after = (parts[index + 1] ?? '').trimStart()
      const bracketCitation =
        UUID_CITATION.test(reference) &&
        close !== undefined &&
        (after.startsWith(close) ||
          new RegExp(`^[,，]\\s*${CITATION_TIME}\\s*[）)\\]〕]`, 'i').test(after))
      return (REFERENCE_PREFIX.test(prefix) &&
        (UUID_CITATION.test(reference) || NUMBER_REFERENCE_PREFIX.test(prefix))) ||
        bracketCitation
        ? reference
        : part
    })
    .join('')
  return prose
    .split(MARKDOWN_LITERAL)
    .map((part, index) => {
      if (index % 2) return part
      const bracketed = part.replace(
        /([（([〔])([^\n()（）[\]〔〕]*)([）)\]〕])/g,
        (original, open: string, inner: string, close: string) => {
          if (UUID_CITATION.test(inner.trim())) return ''
          const withoutIdentifiers = dropReferences(inner.replace(UUID_REFERENCE, '')).replace(
            UUID_BEFORE_TIME,
            '',
          )
          const withoutReferences = /\d{1,2}:\d{2}/.test(withoutIdentifiers)
            ? withoutIdentifiers.replace(CITATION_SEQUENCE, '')
            : withoutIdentifiers
          if (withoutReferences === inner) return original
          const clean = withoutReferences
            .replace(/\s+([,，、;；])/g, '$1')
            .replace(/^[\s,，、;；]+|[\s,，、;；]+$/g, '')
          return clean ? `${open}${clean}${close}` : ''
        },
      )
      const clean = dropReferences(
        bracketed.replace(UUID_REFERENCE_AT_LINE_END, '').replace(UUID_REFERENCE, ''),
      )
      if (clean === part) return part
      return clean
        .replace(/[ \t]+([，。；、,.!?])/g, '$1')
        .replace(/(?<=\S)[ \t]{2,}/g, ' ')
        .replace(/[ \t]+$/gm, '')
    })
    .join('')
}
