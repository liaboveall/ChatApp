/**
 * The one Markdown renderer (docs/07 SEC-05, D-045, D-047, D-145). User messages use `static`; the Agent's streaming
 * output (M4) uses `streaming` with the same configuration, so what is safe for one is safe for the other.
 *
 * What it does not do is as important as what it does: no raw HTML (HTML in a message is shown as the text it is),
 * no math, no diagrams, no outside pictures (an image becomes a link), links only to http, https and mailto, code
 * highlighted with Shiki's JavaScript engine, precompiled grammars (`code-plugin.ts`) and a CSS-variable theme (no WebAssembly, no inline styles).
 */
import { createCjkPlugin } from '@streamdown/cjk'
import { type ComponentProps, type ReactNode, useContext } from 'react'
import { createCssVariablesTheme } from 'shiki/core'
import { defaultRehypePlugins, Streamdown, type StreamdownProps } from 'streamdown'
import { m } from '@/paraglide/messages.js'
import { createCodePlugin } from './code-plugin.ts'
import { LinkTabIndex } from './link-context.ts'
import { cjkAutolinkBoundary, restrictToSubset, softBreaks } from './plugins.ts'
import { opensInNewTab, safeUrl } from './safe-url.ts'

const cssVariablesTheme = createCssVariablesTheme({
  name: 'chatapp-css-vars',
  variablePrefix: '--shiki-',
  variableDefaults: {},
  fontStyle: true,
})
const shikiTheme: [typeof cssVariablesTheme, typeof cssVariablesTheme] = [
  cssVariablesTheme,
  cssVariablesTheme,
]

const cjk = createCjkPlugin()
const plugins = {
  code: createCodePlugin({ themes: shikiTheme }),
  // The order matters: links are cut at CJK first, then the subset rule runs on the finished tree, then breaks are made.
  cjk: {
    ...cjk,
    remarkPluginsAfter: [
      ...cjk.remarkPluginsAfter,
      cjkAutolinkBoundary,
      restrictToSubset,
      softBreaks,
    ],
  },
}

function SafeLink({
  href,
  children,
  node: _node,
  ...rest
}: ComponentProps<'a'> & { node?: unknown }): ReactNode {
  const tabIndex = useContext(LinkTabIndex)
  const safe = typeof href === 'string' ? safeUrl(href) : null
  if (safe === null) return <span data-md="link-dropped">{children}</span>
  return (
    <a
      {...rest}
      href={safe}
      data-md="link"
      rel="noopener noreferrer"
      target={opensInNewTab(safe) ? '_blank' : undefined}
      tabIndex={tabIndex}
    >
      {children}
    </a>
  )
}

/** A Markdown picture is a link: the page policy only loads pictures from itself (`img-src`), and nothing is fetched. */
function ImageAsLink({ src, alt }: ComponentProps<'img'> & { node?: unknown }): ReactNode {
  const tabIndex = useContext(LinkTabIndex)
  const safe = typeof src === 'string' ? safeUrl(src) : null
  const label = alt !== undefined && alt.length > 0 ? alt : (safe ?? '')
  if (safe === null) return <span data-md="image-dropped">{label}</span>
  return (
    <a
      data-md="image-link"
      href={safe}
      rel="noopener noreferrer"
      target="_blank"
      tabIndex={tabIndex}
    >
      {label}
    </a>
  )
}

// No rehype-raw: the HTML nodes of a message become text. Sanitizing stays as a second line of defence.
const rehypePlugins = [defaultRehypePlugins.sanitize as never]
const components = { a: SafeLink as never, img: ImageAsLink as never }
const controls = {
  code: { copy: true, download: false },
  table: false,
  mermaid: false,
  image: false,
} as const
const linkSafety = { enabled: false }
const urlTransform = (url: string): string => safeUrl(url) ?? ''

/**
 * Fetches the grammar of one language and registers it, without drawing anything (a code block in a language that is new to the
 * page is otherwise drawn as plain text first and highlighted a moment later). Called one language at a time in idle time by
 * `lazy.ts` (D-162, D-168). If the file cannot be fetched (the network drops, or the page is left while it loads, which WebKit
 * reports as a cancelled request) the head start is simply not made, and the next block in that language asks again.
 */
export async function warmHighlighter(language: string): Promise<void> {
  try {
    await plugins.code.preload(language)
  } catch {
    // Nothing to report: the block will ask for the grammar itself.
  }
}

export type SafeMarkdownProps = Pick<StreamdownProps, 'mode' | 'isAnimating' | 'className'> & {
  children: string
}

export function SafeMarkdown({ children, ...props }: SafeMarkdownProps): ReactNode {
  return (
    <Streamdown
      {...props}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
      linkSafety={linkSafety}
      components={components}
      plugins={plugins}
      controls={controls}
      shikiTheme={shikiTheme}
      translations={{ copyCode: m.common_copy(), copied: m.common_copied() }}
    >
      {children}
    </Streamdown>
  )
}
