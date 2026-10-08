import { defineConfig, devices } from '@playwright/test'

/**
 * Visual regression tests (docs/08 section 2, L-08): every Storybook story tagged `visual`, in light and dark. Baselines
 * are made and compared ONLY inside the official Playwright Linux image (`bun run test:visual`): fonts and text rendering
 * differ on WSL and Windows, so a screenshot taken there never matches.
 */
export default defineConfig({
  testDir: './visual',
  // E2E and visual runners must not clear each other's live traces.
  outputDir: '../../.test-runs/visual/results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0.1, animations: 'disabled', caret: 'hide' },
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:6007',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    deviceScaleFactor: 1,
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'node visual/serve-static.mjs storybook-static 6007',
    url: 'http://127.0.0.1:6007/iframe.html',
    reuseExistingServer: false,
  },
})
