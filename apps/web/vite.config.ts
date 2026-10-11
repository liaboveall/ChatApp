import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type ProxyOptions } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { neutral } from './src/design/tokens.ts'
import { SECURITY_HEADERS } from './tools/csp.ts'
import { designTokens } from './tools/design-tokens-plugin.ts'
import { precacheIgnores } from './tools/precache.ts'

const API_TARGET = process.env.API_TARGET ?? 'http://127.0.0.1:3100'

/** The installed app (docs/01 section 3.5, M6): the manifest, and the service worker that keeps the public shell. */
const pwa = (): Plugin[] =>
  VitePWA({
    strategies: 'injectManifest',
    srcDir: 'src/sw',
    filename: 'sw.ts',
    // The page registers the worker itself, through a Trusted Types policy of one purpose (docs/07 SEC-06, D-206).
    injectRegister: false,
    manifestFilename: 'manifest.webmanifest',
    manifest: {
      id: '/',
      name: 'ChatApp',
      short_name: 'ChatApp',
      description: 'Chat, share files and ask the assistant, in one place.',
      lang: 'zh-CN',
      dir: 'ltr',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      // Chromium browsers draw the page into the title bar of the installed window when asked; the rest use `standalone`.
      display_override: ['window-controls-overlay', 'standalone'],
      orientation: 'any',
      // The app background of the light theme (tokens.ts); the page's `theme-color` follows the theme in use (index.html).
      background_color: neutral['bg-app'][0],
      theme_color: neutral['bg-app'][0],
      categories: ['social', 'productivity'],
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        {
          src: '/icons/icon-maskable-512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        },
      ],
    },
    injectManifest: {
      // A classic script: no module worker needed, and the same file works in every engine we support.
      rollupFormat: 'iife',
      globPatterns: [
        'index.html',
        'theme-init.js',
        'favicon.svg',
        'icons/{apple-touch-icon,favicon-16,favicon-32}.png',
        'assets/**/*.{js,css,woff2}',
      ],
      globIgnores: precacheIgnores(
        readFileSync(
          fileURLToPath(new URL('./src/components/markdown/code-plugin.ts', import.meta.url)),
          'utf8',
        ),
      ),
    },
    devOptions: { enabled: false },
  })

/** Same-origin proxy to the API (docs/03 section 4): cookies work because the browser only ever talks to this origin. */
const proxy: Record<string, ProxyOptions> = {
  // xfwd: the API trusts this proxy (TRUSTED_PROXIES) and rate-limits by the address it forwards (SEC-28).
  '/api': { target: API_TARGET, xfwd: true },
  '/ws': { target: API_TARGET.replace(/^http/, 'ws'), ws: true, xfwd: true },
}

/**
 * Trusted Types (D-146): micromark decodes `&name;` entities with `decode-named-character-reference`, whose "browser" build
 * writes the entity through an element's HTML-string setter, a sink the page policy refuses. Its default build looks the name up in a
 * table instead and writes nothing to the DOM. Resolve the package normally (so the install layout does not matter) and
 * take the default build next to it. Without this, the first message with an entity in it breaks the whole renderer.
 */
const entitiesTable = (): Plugin => ({
  name: 'chatapp-entities-table',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (source !== 'decode-named-character-reference') return null
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
    if (!resolved) return null
    return { ...resolved, id: resolved.id.replace(/index\.dom\.js$/, 'index.js') }
  },
})

export default defineConfig({
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  envPrefix: 'VITE_PUBLIC_',
  resolve: { tsconfigPaths: true },
  plugins: [
    entitiesTable(),
    designTokens(),
    // The router plugin must come before the React plugin.
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/paraglide',
      strategy: ['localStorage', 'preferredLanguage', 'baseLocale'],
    }),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    pwa(),
  ],
  server: {
    // 127.0.0.1, not "localhost": WSL forwards IPv4 loopback to Windows. The browser still uses http://localhost:5173.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy,
  },
  // The preview server is what end-to-end tests run against, with the production policy applied (docs/07 SEC-06).
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy, headers: SECURITY_HEADERS },
  build: {
    target: ['chrome123', 'edge123', 'firefox128', 'safari17.5'],
    sourcemap: false,
    rolldownOptions: {
      // Modules must run in source order across chunks: lib/zod-config.ts has to run before any schema is created,
      // otherwise Zod probes `new Function` and the CSP reports it (docs/07 SEC-06).
      output: { strictExecutionOrder: true },
    },
  },
})
