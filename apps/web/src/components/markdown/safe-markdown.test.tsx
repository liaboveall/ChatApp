import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { MentionContext } from './mention-context.ts'
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

describe('mentions use the server projection and current names', () => {
  const id = '10000000-0000-4000-8000-000000000001'
  const user = {
    id,
    profileVersion: 2,
    username: 'bobby',
    displayName: 'Bob renamed',
    avatarUrl: null,
    isBot: false,
    deleted: false,
  }
  test('only accepted text mentions are linked, highlighted and renamed; inline code stays literal', () => {
    const html = renderToStaticMarkup(
      <MentionContext.Provider value={{ users: { [id]: user }, valid: [id], meId: id }}>
        <SafeMarkdown>{`Hello <@user:${id}> and \`<@user:${id}>\``}</SafeMarkdown>
      </MentionContext.Provider>,
    )
    expect(html).toContain('data-self="true"')
    expect(html).toContain('@Bob renamed')
    expect(html.match(/class="mention"/g)).toHaveLength(1)
    expect(html).toContain('&lt;@user:')
  })
  test('an unknown or rejected token remains literal', () => {
    expect(render(`<@user:${id}>`)).toContain('&lt;@user:')
    expect(render(`<@user:${id}>`)).not.toContain('class="mention"')
  })
})
