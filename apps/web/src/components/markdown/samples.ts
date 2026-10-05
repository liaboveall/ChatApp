/**
 * Markdown inputs with the output each must produce under the safe renderer (docs/07 SEC-05, D-145): raw HTML as text,
 * only http/https/mailto links, CJK-aware autolinks, no pictures from outside, the product's subset of Markdown. The checks
 * are on serialised markup, so the same list serves the static render test and a browser page.
 * (Ported from the V-08 experiment's sample list.)
 */
export type Check = [label: string, ok: boolean]
export type Sample = { id: string; markdown: string; expect: (html: string) => Check[] }

const has = (html: string, text: string): Check => [
  `contains ${JSON.stringify(text)}`,
  html.includes(text),
]
const lacks = (html: string, text: string): Check => [
  `lacks ${JSON.stringify(text)}`,
  !html.includes(text),
]
const match = (html: string, re: RegExp): Check => [`matches ${re}`, re.test(html)]
const noMatch = (html: string, re: RegExp): Check => [`no match ${re}`, !re.test(html)]

/** Every anchor that survived carries rel="noopener noreferrer" and an allowed protocol. */
const anchorsSafe = (html: string): Check[] => {
  const anchors = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])
  return [
    [
      'every <a> has rel="noopener noreferrer"',
      anchors.every((a) => a.includes('rel="noopener noreferrer"')),
    ],
    [
      'every <a> href is http(s)/mailto',
      anchors.every((a) => /href="(https?:|mailto:)/i.test(a) || !a.includes('href=')),
    ],
  ]
}

// Streamdown's own chrome (copy button icons are <svg>, max-height/content-visibility come from React style props, which
// the browser applies through CSSOM) is allowed; whether anything was blocked is what the CSP listener in the page decides.
const common = (html: string): Check[] => [
  noMatch(html, /<(script|iframe|object|embed|style|math|form|img|link|meta|base)\b/i),
  noMatch(html, /<[^>]*\son[a-z]+=/i),
  noMatch(html, /href="\s*(javascript|vbscript|data):/i),
  noMatch(html, /\ssrc="/i),
  ...anchorsSafe(html),
]

export const SAMPLES: Sample[] = [
  {
    id: 'raw-html-img-onerror',
    markdown: 'before <img src=x onerror="window.__xss=1"> after',
    expect: (h) => [...common(h), lacks(h, '<img'), has(h, '&lt;img src=x onerror=')],
  },
  {
    id: 'raw-html-script-block',
    markdown: '<script>window.__xss=2</script>\n\ntext',
    expect: (h) => [
      ...common(h),
      lacks(h, '<script'),
      has(h, '&lt;script&gt;window.__xss=2&lt;/script&gt;'),
    ],
  },
  {
    id: 'raw-html-div-style',
    markdown: '<div style="color:red" onclick="window.__xss=3">hi</div>',
    expect: (h) => [...common(h), lacks(h, '<div style'), has(h, '&lt;div style=')],
  },
  {
    id: 'raw-html-svg-onload',
    markdown: '<svg onload="window.__xss=4"><circle r="5"/></svg>',
    expect: (h) => [...common(h), has(h, '&lt;svg onload=')],
  },
  {
    id: 'raw-html-iframe-srcdoc', // guard-allow: a hostile sample, shown as text
    markdown: '<iframe srcdoc="<script>window.__xss=5</script>"></iframe>', // guard-allow: a hostile sample, shown as text
    expect: (h) => [...common(h), lacks(h, '<iframe'), has(h, '&lt;iframe')],
  },
  {
    id: 'link-javascript',
    markdown:
      '[click](javascript:window.__xss=6) and [mixed](JaVaScRiPt:alert(1)) and [entity](&#106;avascript:alert(1))',
    expect: (h) => [...common(h), noMatch(h, /href="[^"]*script:/i), has(h, 'click')],
  },
  {
    id: 'link-data-url',
    markdown: '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    expect: (h) => [...common(h), lacks(h, 'href="data:')],
  },
  {
    id: 'link-relative-and-protocol-relative',
    markdown: '[rel](/c/123) [proto](//evil.example/x) [file](file:///etc/passwd) [tel](tel:123)',
    expect: (h) => [
      ...common(h),
      lacks(h, 'href="/'),
      lacks(h, 'href="file:'),
      lacks(h, 'href="tel:'),
    ],
  },
  {
    id: 'link-noopener',
    markdown: '[ok](https://example.com/a?b=1#c "title")',
    expect: (h) => [
      ...common(h),
      match(h, /<a [^>]*href="https:\/\/example\.com\/a\?b=1#c"/),
      match(h, /<a [^>]*target="_blank"/),
    ],
  },
  {
    id: 'link-mailto',
    markdown: '[mail me](mailto:someone@example.com)',
    expect: (h) => [
      ...common(h),
      match(h, /<a [^>]*href="mailto:someone@example\.com"/),
      noMatch(h, /mailto[^>]*target=/),
    ],
  },
  {
    id: 'autolink-plain',
    markdown: 'see https://example.com/path?q=1 end',
    expect: (h) => [
      ...common(h),
      match(
        h,
        /<a [^>]*href="https:\/\/example\.com\/path\?q=1"[^>]*>https:\/\/example\.com\/path\?q=1<\/a> end/,
      ),
    ],
  },
  {
    id: 'autolink-cjk-ideograph-after-path',
    markdown: '看这个https://example.com/docs然后继续',
    expect: (h) => [
      ...common(h),
      match(
        h,
        /<a [^>]*href="https:\/\/example\.com\/docs"[^>]*>https:\/\/example\.com\/docs<\/a>然后继续/,
      ),
    ],
  },
  {
    id: 'autolink-cjk-ideograph-after-domain',
    markdown: '打开https://example.com然后看',
    expect: (h) => [
      ...common(h),
      match(h, /href="https:\/\/example\.com"[^>]*>https:\/\/example\.com<\/a>然后看/),
    ],
  },
  {
    id: 'autolink-cjk-fullwidth-comma',
    markdown: '链接：https://example.com/a，谢谢',
    expect: (h) => [
      ...common(h),
      match(h, /href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>，谢谢/),
    ],
  },
  {
    id: 'autolink-cjk-ideographic-full-stop',
    markdown: '地址https://example.com/x。下一句',
    expect: (h) => [
      ...common(h),
      match(h, /href="https:\/\/example\.com\/x"[^>]*>https:\/\/example\.com\/x<\/a>。下一句/),
    ],
  },
  {
    id: 'autolink-kana-hangul',
    markdown: 'https://example.com/aです and https://example.com/b입니다',
    expect: (h) => [
      ...common(h),
      match(h, /href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>です/),
      match(h, /href="https:\/\/example\.com\/b"[^>]*>https:\/\/example\.com\/b<\/a>입니다/),
    ],
  },
  {
    // GFM only starts a www. literal after whitespace, start of line or one of *_~( : glued to CJK it stays text.
    id: 'autolink-www-glued-to-cjk-stays-text',
    markdown: '去www.example.com中文',
    expect: (h) => [...common(h), lacks(h, '<a '), has(h, '去www.example.com中文')],
  },
  {
    id: 'autolink-www-cjk',
    markdown: '去 www.example.com中文',
    expect: (h) => [
      ...common(h),
      match(h, /href="http:\/\/www\.example\.com"[^>]*>www\.example\.com<\/a>中文/),
    ],
  },
  {
    id: 'autolink-email-cjk',
    markdown: '联系someone@example.com谢谢',
    expect: (h) => [
      ...common(h),
      match(h, /href="mailto:someone@example\.com"[^>]*>someone@example\.com<\/a>谢谢/),
    ],
  },
  {
    id: 'autolink-angle',
    markdown: '<https://example.com/angle>',
    expect: (h) => [...common(h), match(h, /href="https:\/\/example\.com\/angle"/)],
  },
  {
    id: 'math-off',
    markdown: 'inline $E=mc^2$ and block\n\n$$\n\\int_0^1 x\\,dx\n$$',
    expect: (h) => [...common(h), lacks(h, 'katex'), has(h, '$E=mc^2$')],
  },
  {
    // Shown as an ordinary (highlighted) code block: the text survives once tags are stripped; no diagram renderer.
    id: 'mermaid-off',
    markdown: '```mermaid\ngraph TD; A-->B\n```',
    expect: (h) => [
      ...common(h),
      lacks(h, 'data-streamdown="mermaid"'),
      has(h, 'data-streamdown="code-block"'),
      has(h.replace(/<[^>]+>/g, ''), 'graph TD; A--&gt;B'),
    ],
  },
  {
    id: 'image-external-becomes-link',
    markdown: '![logo](https://evil.example/x.png)',
    expect: (h) => [
      ...common(h),
      lacks(h, '<img'),
      match(h, /<a [^>]*href="https:\/\/evil\.example\/x\.png"/),
    ],
  },
  {
    id: 'image-data-dropped',
    markdown:
      '![pixel](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==)',
    expect: (h) => [...common(h), lacks(h, '<img'), lacks(h, 'data:image')],
  },
  {
    id: 'code-fence-ts',
    markdown:
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the sample is Markdown source whose code contains a template literal
      '```ts\nconst answer: number = 42 // comment\nfunction greet(name: string) { return `hi ${name}` }\n```',
    expect: (h) => [...common(h), has(h, 'answer')],
  },
  {
    // The product's subset (docs/01 section 4.5): tables, task lists and footnotes are not rendered as such; strikethrough is.
    id: 'subset-table-task-footnote-as-text',
    markdown:
      '| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~ and ~删除~\n\nNote[^1].\n\n[^1]: The footnote.',
    expect: (h) => [
      ...common(h),
      lacks(h, '<table'),
      lacks(h, 'type="checkbox"'),
      has(h, '[x] done'),
      has(h, '[ ] todo'),
      has(h, '<del'),
      has(h, '| a | b |'),
      has(h, 'The footnote.'),
    ],
  },
  {
    id: 'subset-headings-are-paragraphs',
    markdown: '# Title\n\n## Sub\n\ntext',
    expect: (h) => [
      ...common(h),
      noMatch(h, /<h[1-6]\b/),
      has(h, '<p>Title</p>'),
      has(h, '<p>Sub</p>'),
    ],
  },
  {
    id: 'soft-break-is-a-line-break',
    markdown: 'line one\nline two',
    expect: (h) => [...common(h), has(h, 'line one<br/>'), has(h, 'line two')],
  },
  {
    id: 'cjk-emphasis',
    markdown: '**中文加粗**后面的字，*斜体*：完成',
    expect: (h) => [...common(h), has(h, '中文加粗'), match(h, /<(strong|span)[^>]*>中文加粗</)],
  },
  {
    id: 'entities',
    markdown: '&lt;b&gt;not bold&lt;/b&gt; &amp; 5 &gt; 3',
    expect: (h) => [...common(h), lacks(h, '<b>'), has(h, '&lt;b&gt;not bold')],
  },
  {
    id: 'streaming-incomplete',
    markdown: 'This is **bold and [a link](https://exa',
    expect: (h) => [...common(h), has(h, 'bold and')],
  },
]
