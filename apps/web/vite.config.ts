import { fileURLToPath } from 'node:url'
import { paraglideVitePlugin } from '@inlang/paraglide-js'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'
import { SECURITY_HEADERS } from './tools/csp.ts'
import { designTokens } from './tools/design-tokens-plugin.ts'

const API_TARGET = process.env.API_TARGET ?? 'http://127.0.0.1:3100'

/** Same-origin proxy to the API (docs/03 section 4): cookies work because the browser only ever talks to this origin. */
const proxy: Record<string, ProxyOptions> = {
  // xfwd: the API trusts this proxy (TRUSTED_PROXIES) and rate-limits by the address it forwards (SEC-28).
  '/api': { target: API_TARGET, xfwd: true },
  '/ws': { target: API_TARGET.replace(/^http/, 'ws'), ws: true, xfwd: true },
}

export default defineConfig({
  envDir: fileURLToPath(new URL('../..', import.meta.url)),
  envPrefix: 'VITE_PUBLIC_',
  resolve: { tsconfigPaths: true },
  plugins: [
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
