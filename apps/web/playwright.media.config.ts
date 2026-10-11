import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './e2e-media',
  outputDir: '../../.test-runs/e2e-media/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4174',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // The app registers a service worker on every page (M6, D-206). Chromium runs with it; in WebKit a request of a page the
  // worker controls escapes `route`, which every `holdRequest` of this chain relies on, so WebKit blocks the worker as the
  // main configuration does.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], serviceWorkers: 'block' } },
  ],
  webServer: [
    {
      command: 'bun run build && bun run preview --port 4174',
      url: 'http://localhost:4174',
      timeout: 180_000,
      reuseExistingServer: false,
      env: { API_TARGET: 'http://127.0.0.1:26401' },
    },
  ],
})
