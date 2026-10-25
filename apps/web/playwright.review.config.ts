import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './review',
  // Keep component traces separate from the real-service E2E artifacts.
  outputDir: '../../test-results/review-components',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 30000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:25177',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'bun x vite --config vite.review.config.ts',
    url: 'http://127.0.0.1:25177',
    reuseExistingServer: false,
    timeout: 60000,
  },
})
