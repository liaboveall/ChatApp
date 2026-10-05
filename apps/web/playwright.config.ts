import { defineConfig, devices } from '@playwright/test'
import { GPU_LAUNCH } from './e2e/support/gpu.ts'

const WEB_PORT = 4173
const API_PORT = 3102
const ORIGIN = `http://localhost:${WEB_PORT}`

/**
 * End-to-end tests (docs/08 sections 2 and 3). They run against a production build served by `vite preview` with the
 * real Content Security Policy, a proxy to the API in the TEST environment, a worker, and Mailpit for the emails.
 * Chromium and WebKit run everything; Firefox runs the smoke tests (@smoke). Needs `bun run infra:up`.
 */
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: ORIGIN,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, grepInvert: /@perf/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grepInvert: /@perf/ },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      grep: /@smoke/,
      grepInvert: /@perf/,
    },
    // The performance scenarios (T1 to T4, latency; docs/12 D-149, D-161) run in Chromium with the graphics card where there
    // is one: headless Chromium otherwise composites in software, where the glass of the toolbar and the composer alone
    // costs three frames in four. On WSL the card is reached through Mesa's d3d12 driver.
    {
      name: 'perf',
      use: { ...devices['Desktop Chrome'], launchOptions: GPU_LAUNCH },
      grep: /@perf/,
    },
  ],
  webServer: [
    {
      command: 'bun --env-file=../../.env.local ../../scripts/e2e-stack.ts',
      url: `http://127.0.0.1:${API_PORT}/api/readyz`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { E2E_API_PORT: String(API_PORT), E2E_APP_ORIGIN: ORIGIN },
    },
    {
      command: 'bun run build && bun run preview',
      url: ORIGIN,
      timeout: 180_000,
      reuseExistingServer: false,
      env: { API_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
})
