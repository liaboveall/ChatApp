import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { SafeMarkdown } from './safe-markdown.tsx'
import { opensInNewTab, safeUrl } from './safe-url.ts'
import { SAMPLES } from './samples.ts'

const render = (markdown: string, mode: 'static' | 'streaming' = 'static') =>
  renderToStaticMarkup(<SafeMarkdown mode={mode}>{markdown}</SafeMarkdown>)

describe('SafeMarkdown on the shared samples (L-11, D-145)', () => {
  for (const sample of SAMPLES) {
    test(sample.id, () => {
      const html = render(sample.markdown)
      const failed = sample.expect(html).filter(([, ok]) => !ok)
      expect(
        failed.map(([label]) => label),
        html,
      ).toEqual([])
    })
  }
})

describe('SafeMarkdown in streaming mode (the Agent will use it, M4)', () => {
  test('applies the same rules to text that is still being written', () => {
    const html = render('half **bold and [a link](https://exa', 'streaming')
    expect(html).toContain('bold and')
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i)
  })

  test('raw HTML is still only text', () => {
    expect(render('<img src=x onerror=alert(1)>', 'streaming')).not.toContain('<img')
  })
})

describe('safeUrl', () => {
  test('accepts absolute http, https and mailto, in any case, and nothing else', () => {
    expect(safeUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(safeUrl('HTTP://EXAMPLE.com')).toBe('HTTP://EXAMPLE.com')
    expect(safeUrl('mailto:a@example.com')).toBe('mailto:a@example.com')
    for (const bad of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'data:text/html,<b>',
      'file:///etc/passwd',
      'tel:123',
      '/relative',
      '//host/path',
      'ftp://example.com',
      'https:',
      '',
      'vbscript:x',
    ]) {
      expect(safeUrl(bad), bad).toBeNull()
    }
  })

  test('web links open in a new tab, mail links do not', () => {
    expect(opensInNewTab('https://example.com')).toBe(true)
    expect(opensInNewTab('mailto:a@example.com')).toBe(false)
  })
})
