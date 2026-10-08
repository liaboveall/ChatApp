import type { JSONValue, ModelMessage } from 'ai'

function isJsonObject(value: unknown): value is { readonly [key: string]: JSONValue | undefined } {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sourceFingerprint(value: unknown): string | undefined {
  if (
    !isJsonObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.conversationId !== 'string' ||
    typeof value.body !== 'string'
  )
    return undefined
  return JSON.stringify(canonical(value))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, part]) => [key, canonical(part)]),
    )
  return value
}

/** Keep every tool-call/result pair and source version; identical supplied history and neighbor pages become references. */
export function compactAgentMessages(
  messages: ModelMessage[],
  providedSources: unknown = [],
): ModelMessage[] {
  const seen = new Set<string>()
  if (Array.isArray(providedSources))
    for (const source of providedSources) {
      const fingerprint = sourceFingerprint(source)
      if (fingerprint) seen.add(fingerprint)
    }
  return messages.map((message) => {
    if (message.role !== 'tool') return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-result' || part.output.type !== 'json') return part
        const value = part.output.value
        if (!isJsonObject(value) || value.trust !== 'untrusted' || !Array.isArray(value.data))
          return part
        const data = value.data.map((row) => {
          const fingerprint = sourceFingerprint(row)
          if (!fingerprint || !isJsonObject(row)) return row
          if (seen.has(fingerprint)) return { id: row.id, alreadyProvided: true }
          seen.add(fingerprint)
          return row
        })
        return { ...part, output: { ...part.output, value: { ...value, data } } }
      }),
    }
  })
}

/** Explicit previews keep fast-mode text bounded; callers may request a smaller page or use deep mode for full text. */
export function boundedAgentData(
  data: unknown,
  maxBytes: number,
  bodyPreviewChars?: number,
): { data: unknown; truncated: boolean; available?: number } {
  if (!Array.isArray(data)) {
    if (Buffer.byteLength(JSON.stringify(data)) <= maxBytes) return { data, truncated: false }
    return {
      data: { preview: String(JSON.stringify(data)).slice(0, Math.floor(maxBytes / 4)) },
      truncated: true,
    }
  }
  const kept: unknown[] = []
  let bytes = 2
  let truncated = false
  for (const item of data) {
    let preview = item
    if (
      item &&
      typeof item === 'object' &&
      'body' in item &&
      typeof item.body === 'string' &&
      (Buffer.byteLength(JSON.stringify(item)) > maxBytes - 2048 ||
        (bodyPreviewChars !== undefined && [...item.body].length > bodyPreviewChars))
    ) {
      const body = [...item.body]
        .slice(
          0,
          Math.min(bodyPreviewChars ?? Infinity, Math.max(100, Math.floor((maxBytes - 2048) / 4))),
        )
        .join('')
      const range =
        'bodyRange' in item && item.bodyRange && typeof item.bodyRange === 'object'
          ? item.bodyRange
          : undefined
      preview = {
        ...item,
        body,
        bodyTruncated: true,
        ...(range ? { bodyRange: { ...range, length: [...body].length } } : {}),
      }
      truncated = true
    }
    const size = Buffer.byteLength(JSON.stringify(preview)) + 1
    if (bytes + size > maxBytes) {
      truncated = true
      break
    }
    kept.push(preview)
    bytes += size
  }
  return { data: kept, truncated, available: data.length }
}
