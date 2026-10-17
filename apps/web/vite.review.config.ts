import { fileURLToPath } from 'node:url'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { designTokens } from './tools/design-tokens-plugin.ts'
import base from './vite.config.ts'

export default defineConfig({
  ...base,
  root: fileURLToPath(new URL('./review', import.meta.url)),
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    (base.plugins ?? [])[0],
    designTokens(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  server: { host: '127.0.0.1', port: 25177, strictPort: true },
})
