#!/usr/bin/env bun
/**
 * Builds the prototype.
 *
 *   bun design/prototype/tools/build.mjs [--minify]
 *
 * Writes to design/prototype/dist (git-ignored):
 *   artifact.html  the page as the Artifact tool wants it: a fragment with <title>, <style>, markup, <script>
 *   index.html     the same fragment inside a document that mimics the artifact skeleton, for local viewing
 *   app.css, app.js  the unwrapped sources, handy for debugging
 *
 * The page needs no network: styles, scripts, icons and the Inter font subset are all inline.
 */
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tokensCss } from './tokens-css.mjs'

const root = join(import.meta.dir, '..')
const src = join(root, 'src')
const dist = join(root, 'dist')
const minify = process.argv.includes('--minify')

const TITLE = 'ChatApp 设计原型'

const styleDir = join(src, 'styles')
const styleFiles = (await readdir(styleDir)).filter((name) => name.endsWith('.css')).sort()
// Inter, Latin subset, inlined (OFL, see src/fonts). It is only fetched and decoded when a page uses it.
const interBytes = new Uint8Array(
  await Bun.file(join(src, 'fonts', 'inter-latin-wght-normal.woff2')).arrayBuffer(),
)
const interFace = `@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: url(data:font/woff2;base64,${Buffer.from(interBytes).toString('base64')}) format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}`
const parts = [
  `/* generated from tools/tokens.mjs */\n${tokensCss()}`,
  `/* inter-latin-wght-normal.woff2 */\n${interFace}`,
]
for (const name of styleFiles) {
  parts.push(`/* ${name} */\n${await Bun.file(join(styleDir, name)).text()}`)
}
const css = parts.join('\n\n')

const bundle = await Bun.build({
  entrypoints: [join(src, 'scripts', 'main.js')],
  target: 'browser',
  format: 'iife',
  minify,
})
if (!bundle.success) {
  for (const log of bundle.logs) console.error(String(log))
  process.exit(1)
}
const js = (await bundle.outputs[0].text()).replaceAll('</script', '<\\/script')

const fragment = `<title>${TITLE}</title>
<style>
${css}
</style>
<div id="root"></div>
<script>
${js}
</script>
`

// Mimics what the Artifact tool wraps around the fragment (see the artifact page contract).
const document = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>
:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
body{margin:0;font:14px system-ui,sans-serif;background:#fafafa;color:#1c1c1e}
img{max-width:100%}
[hidden]{display:none!important}
</style>
</head>
<body>
${fragment}</body>
</html>
`

await mkdir(dist, { recursive: true })
await Bun.write(join(dist, 'artifact.html'), fragment)
await Bun.write(join(dist, 'index.html'), document)
await Bun.write(join(dist, 'app.css'), css)
await Bun.write(join(dist, 'app.js'), js)

const kb = (text) => `${(new TextEncoder().encode(text).length / 1024).toFixed(1)} KB`
console.log(
  `built: css ${kb(css)} (${styleFiles.length} files), js ${kb(js)}, artifact.html ${kb(fragment)}`,
)
