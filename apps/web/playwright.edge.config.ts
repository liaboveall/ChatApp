import { defineConfig, devices } from '@playwright/test'

const ORIGIN = 'https://chat.localhost:8443'
const API_PORT = 3104

// The test helpers read the site's address from here (they run in the worker processes, which load this file too).
process.env.E2E_ORIGIN = ORIGIN

/**
 * The edge suite (docs/08, docs/12 D-147): the application behind the real gateway, over HTTPS, in Chromium. The gateway
 * is Nginx in a container with the production site configuration (`bun run edge:up`, or `bun run test:edge` for everything
 * in one go); Playwright starts the test-environment API behind it on port 3104. It owns the test database while it runs
 * and is not part of CI. Everything the browser sends reaches the API from the gateway's address, so the suite keeps its
 * registrations and sign-ins few and stops at the first 429.
 *
 *   bun run test:edge
 */
export default defineConfig({
  testDir: './edge',
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: ORIGIN,
    ignoreHTTPSErrors: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun --env-file=../../.env.local ../../scripts/e2e-stack.ts',
    // Ready when the whole chain answers: gateway, then the host's forwarding into WSL, then the API. The API itself
    // answers on 127.0.0.1 at once, but the container reaches the host through Docker Desktop, which notices a new listener
    // a moment later; a test that started in between got a 502.
    url: `${ORIGIN}/api/readyz`,
    ignoreHTTPSErrors: true,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      E2E_API_PORT: String(API_PORT),
      E2E_APP_ORIGIN: ORIGIN,
      E2E_LOG_LEVEL: 'info',
      // The API's log goes to a file the suite reads for the "no sentinel in any log" checks (AT-26).
      E2E_LOG_FILE: '../../.test-runs/edge/api.log',
    },
  },
})
