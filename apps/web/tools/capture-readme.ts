/**
 * Capture the real web client against browser-local synthetic HTTP/WebSocket fixtures.
 * Run from the repository root: bun run --cwd apps/web tools/capture-readme.ts
 * This script starts and stops its own loopback-only Vite server. No backend or AI credentials are used.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  agentRunDetailSchema,
  conversationListResponseSchema,
  meSchema,
  messagesResponseSchema,
  SITE_LIMIT_DEFAULTS,
} from '@chatapp/contracts'
import { type Browser, chromium, expect, type Page } from '@playwright/test'
import { uuid } from '../src/lib/sync/fixtures.ts'
import {
  agent,
  approval,
  assistant,
  bob,
  conversations,
  file,
  launch,
  me,
  messages,
  NOW,
  outgoing,
  panel,
  runs,
  users,
} from './readme-fixtures.ts'

const origin = 'http://127.0.0.1:25178'
const web = fileURLToPath(new URL('..', import.meta.url))
const output = fileURLToPath(new URL('../../../docs/assets/demo/', import.meta.url))
const reportDir = fileURLToPath(new URL('../../../.test-runs/readme-demo/', import.meta.url))
await mkdir(output, { recursive: true })
await mkdir(reportDir, { recursive: true })
meSchema.parse(me)
conversationListResponseSchema.parse({ conversations, userChangeSeq: 0 })
for (const scene of Object.values(messages))
  messagesResponseSchema.parse({
    messages: scene,
    users,
    hasMoreBefore: false,
    hasMoreAfter: false,
  })
for (const detail of runs) agentRunDetailSchema.parse(detail)

if (
  await fetch(origin)
    .then(() => true)
    .catch(() => false)
)
  throw new Error(`Demo port is already in use: ${origin}`)
const server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '25178'], {
  cwd: web,
  env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  stdio: 'ignore',
})
let browser: Browser | undefined
const errors: string[] = []
const unexpected: string[] = []
const captures: string[] = []
let approved = false
async function settle(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
}
async function capture(page: Page, name: string) {
  await settle(page)
  const text = await page.locator('body').innerText()
  assert(!/[\u3400-\u9fff]/u.test(text), `Non-English content in ${name}`)
  assert(
    !/Something went wrong|Unable to load|No such conversation/.test(text),
    `Broken scene: ${name}\n${text}\nUnhandled: ${unexpected.join(', ')}`,
  )
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: 'disabled' })
  captures.push(name)
  console.log(`Captured ${name}`)
}
try {
  browser = await chromium.launch({ headless: true })
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite exited: ${server.exitCode}`)
    if (
      await fetch(origin)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break
    if (attempt > 100) throw new Error('Vite did not start')
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'Asia/Singapore',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  })
  await context.addInitScript(() => {
    localStorage.setItem('PARAGLIDE_LOCALE', 'en')
    localStorage.setItem(
      'chatapp.appearance',
      JSON.stringify({ theme: 'light', reduceMotion: true }),
    )
  })
  // Every request to an API is fulfilled here; an unhandled API request fails the capture.
  await context.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const answer = (json: unknown) => route.fulfill({ json })
    if (path === '/api/me') return answer(me)
    if (path === '/api/monitoring/config') return answer({ enabled: false })
    if (path === '/api/site-limits')
      return answer({
        messageRecallWindowMs: SITE_LIMIT_DEFAULTS.messageRecallWindowMs,
        messageEditWindowMs: SITE_LIMIT_DEFAULTS.messageEditWindowMs,
        fileBytes: SITE_LIMIT_DEFAULTS.fileBytes,
        imageBytes: SITE_LIMIT_DEFAULTS.imageBytes,
      })
    if (path === '/api/conversations') return answer({ conversations, userChangeSeq: 0 })
    if (path === '/api/notifications')
      return answer({ items: [], nextCursor: null, unreadCount: 0 })
    if (path === '/api/sync/heads')
      return answer({
        userChangeSeq: 0,
        conversations: conversations.map((c) => ({
          id: c.id,
          membershipId: c.me?.membershipId,
          lastChangeSeq: c.lastChangeSeq,
          metadataVersion: c.metadataVersion,
          membershipVersion: c.membershipVersion,
          viewerVersion: c.viewerVersion,
        })),
      })
    if (path === '/api/me/changes')
      return answer({
        items: [],
        scannedThrough: 0,
        through: 0,
        nextCursor: null,
        resetRequired: false,
        baseline: null,
      })
    if (path === '/api/me/ai-key') return answer({ aiKey: null })
    if (path === '/api/reminders') return answer({ reminders: [], nextCursor: null })
    if (path === '/api/scheduled-messages')
      return answer({ scheduledMessages: [], nextCursor: null })
    if (path === '/api/me/memories')
      return answer({
        memories: [
          {
            id: uuid(960),
            content: 'Keep project updates concise and list the owner of each next step.',
            source: 'user',
            privacyClass: 'standard',
            contentVersion: 1,
            createdByRunId: null,
            createdAt: NOW,
            deletedAt: null,
          },
        ],
      })
    if (path === '/api/agent/usage')
      return answer({
        provider: 'mock',
        day: '2026-10-20',
        month: '2026-10',
        keySource: 'site',
        warning: false,
        paused: false,
        daily: {
          limit: 500000,
          settled: 28400,
          reserved: 0,
          unknown: 0,
          available: 471600,
          resetAt: '2026-10-20T16:00:00.000Z',
        },
        monthly: {
          limitMicroUsd: 10000000,
          settledMicroUsd: 0,
          reservedMicroUsd: 0,
          unknownMicroUsd: 0,
          availableMicroUsd: 10000000,
          resetAt: '2026-10-31T16:00:00.000Z',
        },
        own: { inputTokens: 0, outputTokens: 0, runCount: 0 },
      })
    if (path === `/api/agent/approvals/${approval.id}`) {
      assert.equal(request.method(), 'POST')
      assert.equal(request.postDataJSON().decision, 'approve')
      const detail = runs[2]
      assert(detail)
      Object.assign(detail.run, {
        status: 'completed',
        pendingApproval: false,
        hasEffects: true,
        stateVersion: 2,
        finishedAt: NOW,
      })
      Object.assign(approval, { status: 'approved', decidedAt: NOW })
      approved = true
      return answer({ approval, run: detail.run })
    }
    const run = runs.find((d) => path === `/api/agent/runs/${d.run.id}`)
    if (run) return answer(run)
    const agentContext = path.match(/^\/api\/agent\/conversations\/([^/]+)\/context$/)
    if (agentContext)
      return answer({
        conversationId: agentContext[1],
        contextEpoch: uuid(800),
        stateVersion: 1,
        historyFromSeq: 0,
        keySource: 'site',
        readScope: agentContext[1] === panel.id ? 'current_conversation' : 'all_accessible',
      })
    const conversation = conversations.find((c) => path.startsWith(`/api/conversations/${c.id}`))
    if (conversation) {
      const suffix = path.slice(`/api/conversations/${conversation.id}`.length)
      if (!suffix || suffix === '/read') return answer(conversation)
      if (suffix === '/messages')
        return answer({
          messages: messages[conversation.id] ?? [],
          users,
          hasMoreBefore: false,
          hasMoreAfter: false,
        })
      if (suffix === '/changes')
        return answer({
          items: [],
          tombstones: [],
          users,
          scannedThrough: conversation.lastChangeSeq,
          through: conversation.lastChangeSeq,
          nextCursor: null,
          membershipId: conversation.me?.membershipId,
          resetRequired: false,
          baseline: null,
        })
      if (suffix === '/members')
        return answer({
          members: Object.values(users)
            .filter((u) => !u.isBot)
            .map((user, index) => ({
              user,
              role: index ? 'member' : 'owner',
              membershipId: uuid(710 + index),
              membershipVersion: 1,
              joinedAt: NOW,
              silencedUntil: null,
            })),
          membershipVersion: conversation.membershipVersion,
          nextCursor: null,
        })
      if (suffix === '/attachments')
        return answer({
          items: [{ attachment: file, messageId: uuid(1005), seq: 5 }],
          nextCursor: null,
        })
      if (suffix === '/bans') return answer({ bans: [], nextCursor: null })
      if (suffix === '/invites') return answer({ invites: [] })
    }
    unexpected.push(`${request.method()} ${path}`)
    return route.fulfill({
      status: 501,
      json: {
        error: { code: 'NOT_FOUND', message: 'Unhandled demo fixture', requestId: 'readme-demo' },
      },
    })
  })
  await context.routeWebSocket('**/ws', (socket) => {
    socket.send(
      JSON.stringify({
        v: 1,
        type: 'hello',
        data: {
          connectionId: uuid(990),
          userId: me.id,
          authEpoch: me.authEpoch,
          restoreEpoch: me.restoreEpoch,
          serverTime: NOW,
          heartbeatMs: 25000,
        },
      }),
    )
    socket.onMessage((data) => {
      const frame = JSON.parse(String(data))
      if (frame.type === 'ping')
        socket.send(JSON.stringify({ v: 1, type: 'pong', data: { serverTime: NOW } }))
      if (frame.type === 'presence.watch')
        socket.send(
          JSON.stringify({
            v: 1,
            type: 'presence.snapshot',
            data: { users: [{ userId: bob.id, status: 'online', lastSeenAt: null }] },
          }),
        )
    })
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/c/${launch.id}`)
  await expect(
    page.getByText('The launch checklist is ready for review.', { exact: true }).last(),
  ).toBeVisible()
  await capture(page, '01-workspace')
  await page.keyboard.press('Control+j')
  await expect(
    page.locator('.agent-panel__messages').getByText('Launch recap', { exact: true }),
  ).toBeVisible()
  await expect(page.locator('.agent-panel__messages')).toContainText('Launch recap')
  await capture(page, '02-agent-panel')
  await page.keyboard.press('Control+j')
  await page.locator(`a[href="/c/${assistant.id}"]`).click()
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await capture(page, '03-agent-approval')
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByText('Approved', { exact: true })).toBeVisible()
  assert(approved)
  // The approval is a fixture response; this capture never sends the proposed message to a real service.
  await capture(page, '04-agent-approved')
  await page.locator(`a[href="/c/${launch.id}"]`).click()
  await page.getByRole('button', { name: 'Members and details', exact: true }).click()
  await expect(page.getByText('launch-checklist.pdf', { exact: true }).last()).toBeVisible()
  await capture(page, '05-shared-files')
  await page.goto(`${origin}/c/${launch.id}?settings=assistant`)
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText('Personal memories', { exact: true })).toBeVisible()
  await capture(page, '06-assistant-settings')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(page.getByRole('dialog')).toBeVisible()
  await capture(page, '07-command-palette')
  await page.keyboard.press('Escape')
  // Change appearance through the application's preferences, then return to the same conversation.
  await page.goto(`${origin}/c/${launch.id}?settings=appearance`)
  await page.getByRole('radio', { name: 'Dark', exact: true }).check()
  await page.keyboard.press('Escape')
  await capture(page, '08-dark-mode')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture(page, '09-narrow-layout')
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'Narrow layout overflows',
  )
  assert.deepEqual(errors, [], 'Browser runtime errors')
  assert.deepEqual(unexpected, [], 'Unhandled fixture requests')
  await writeFile(
    `${reportDir}/capture.json`,
    JSON.stringify(
      {
        source:
          'Real application UI with browser-local synthetic API and WebSocket fixtures; no live AI or backend.',
        locale: 'en-US',
        viewport: '1440x960; narrow 390x844',
        captures,
        errors,
        unexpected,
        approvalInteraction: approved,
        proposedMessage: outgoing,
        bot: agent.displayName,
      },
      null,
      2,
    ),
  )
  console.log(`Saved ${captures.length} English screenshots; approval and layout checks passed.`)
} catch (error) {
  await writeFile(
    `${reportDir}/failure-${Date.now()}.json`,
    JSON.stringify(
      {
        error: String(error),
        captures,
        errors,
        unexpected,
      },
      null,
      2,
    ),
  )
  throw error
} finally {
  try {
    await browser?.close()
  } finally {
    server.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      if (server.exitCode !== null || server.signalCode !== null) resolve()
      else server.once('exit', () => resolve())
    })
  }
}
