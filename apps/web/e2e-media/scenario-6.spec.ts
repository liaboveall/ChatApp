import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { APIRequestContext } from '@playwright/test'
import { composer, openDetails, openFromSidebar } from '../e2e/support/chat.ts'
import { expect, newContext, test } from '../e2e/support/fixtures.ts'
import {
  holdRequest,
  identityStatus,
  sessionCookie,
  signInInPlace,
  signOutInPlace,
} from '../e2e/support/late.ts'
import { signIn } from '../e2e/support/ui.ts'

const directory = resolve('../../.test-runs/e2e-media')
type Person = { id: string; email: string; password: string; name: string }
const people = (): Person[] => JSON.parse(readFileSync(resolve(directory, 'accounts.json'), 'utf8'))
async function signedIn(api: APIRequestContext, person: Person) {
  const reply = await api.post('/api/auth/sign-in/email', {
    headers: { origin: 'http://localhost:4174' },
    data: { email: person.email, password: person.password },
  })
  expect(reply.ok()).toBe(true)
}
async function group(api: APIRequestContext, name: string, memberIds: string[] = []) {
  const reply = await api.post('/api/conversations', {
    headers: { origin: 'http://localhost:4174', 'idempotency-key': crypto.randomUUID() },
    data: { kind: 'group', name, memberIds },
  })
  expect(reply.ok()).toBe(true)
  return (await reply.json()).id as string
}

test('a late native image 401 has no Cookie effects on the next person in the same page', async ({
  page,
  request,
}) => {
  const [alice, bob] = people()
  if (!alice || !bob) throw new Error('fixtures missing')
  await signedIn(request, bob)
  const name = `媒体会话边界 ${Date.now()}`
  const id = await group(request, name)
  await signIn(page, alice.email, alice.password)
  const path = '/api/attachments/10000000-0000-4000-8000-000000000099/original'
  const held = await holdRequest(page, new RegExp(`${path}$`), 'GET')
  // A real native image request remains in this document while the SPA changes identity.
  await page.evaluate((src) => {
    const image = document.createElement('img')
    image.alt = ''
    image.src = src
    document.body.append(image)
  }, path)
  await held.requested
  await signOutInPlace(page)
  await signInInPlace(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect(composer(page)).toBeVisible()
  await composer(page).fill('后一账号的草稿')
  const cookie = await sessionCookie(page)
  expect(cookie).not.toBeNull()
  expect(await identityStatus(page)).toBe(200)
  const answer = await held.sendToServer()
  expect(answer.status).toBe(401)
  expect(answer.setCookies).toEqual([])
  await held.deliver() // deliver every original response header, without deleting or rewriting any
  expect(await sessionCookie(page)).toBe(cookie)
  expect(await identityStatus(page)).toBe(200)
  await expect(composer(page)).toHaveValue('后一账号的草稿')
  await expect(page).toHaveURL(`/c/${id}`)
})

test('scenario 6: real images and GIF, file card, mention, lightbox, shared files and recall', async ({
  page,
  request,
  browser,
}) => {
  const [alice, bob] = people()
  if (!alice || !bob) throw new Error('fixtures missing')
  await signedIn(request, alice)
  const id = await group(request, `富消息 ${Date.now()}`, [bob.id])
  await signIn(page, alice.email, alice.password)
  await page.goto(`/c/${id}`)
  await expect(composer(page)).toBeVisible()
  const thumbRequests = new Set<string>()
  page.on('request', (request) => {
    if (request.url().endsWith('/thumb')) thumbRequests.add(request.url())
  })
  const heldReservation = await holdRequest(
    page,
    /\/api\/uploads\/reservations$/,
    'POST',
    (body) => (JSON.parse(body ?? '{}') as { name?: string }).name === 'photo.jpeg',
  )
  await page.locator('.composer input[type=file]').setInputFiles([
    {
      name: 'photo.jpeg',
      mimeType: 'image/jpeg',
      buffer: readFileSync(resolve(directory, 'jpeg.input')),
    },
    {
      name: 'motion.gif',
      mimeType: 'image/gif',
      buffer: readFileSync(resolve(directory, 'gif.input')),
    },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('附件测试文本') },
  ])
  await heldReservation.requested
  await expect(page.getByRole('progressbar', { name: 'photo.jpeg' })).toBeVisible()
  await heldReservation.sendToServer()
  await heldReservation.deliver()
  await expect(page.locator('.upload-draft')).toHaveCount(3)
  await expect(page.locator('.composer__send')).toBeEnabled({ timeout: 60_000 })
  await composer(page).fill('@bobby')
  await composer(page).press('ArrowLeft')
  await composer(page).press('ArrowRight')
  await expect(page.getByRole('listbox', { name: '提及成员' })).toBeVisible()
  await expect(composer(page)).toHaveAttribute('aria-activedescendant', /.+/)
  await composer(page).press('Escape')
  await expect(page.locator('.mention-picker')).toBeHidden()
  await composer(page).fill('@bobbyx')
  await composer(page).fill('@bobby')
  await expect(page.locator('.mention-picker')).toBeVisible()
  await composer(page).press('Enter')
  await expect(composer(page)).toHaveValue(`<@user:${bob.id}> `)
  await composer(page).press('Enter')
  await expect(page.locator('.upload-draft')).toHaveCount(0)
  const bubble = page.locator('.msg-article').filter({ has: page.locator('.file-card') })
  await expect(bubble.locator('.attachment-grid img')).toHaveCount(2)
  for (const image of await bubble.locator('.attachment-grid img').all()) {
    await expect(image).toHaveAttribute('src', /\/thumb$/)
    const source = await image.getAttribute('src')
    expect(thumbRequests.has(new URL(source ?? '', page.url()).href)).toBe(true)
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0)
  }
  await expect(bubble.locator('.mention')).toHaveText('@bobby')
  await expect(
    page.locator('.s-item__preview').filter({ hasText: '@bobby' }).first(),
  ).not.toContainText('<@user:')
  await expect(bubble.locator('.file-card')).toContainText('notes.txt')
  await bubble.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '回复', exact: true }).click()
  await expect(page.locator('.composer__ctx')).toContainText('@bobby')
  await expect(page.locator('.composer__ctx')).not.toContainText('<@user:')
  await composer(page).fill('引用提及')
  const heldReply = await holdRequest(
    page,
    new RegExp(`/api/conversations/${id}/messages$`),
    'POST',
  )
  await composer(page).press('Enter')
  await heldReply.requested
  await expect(page.locator('.bubble--sending .bubble__quote')).toContainText('@bobby')
  await expect(page.locator('.bubble--sending .bubble__quote')).not.toContainText('<@user:')
  await heldReply.sendToServer()
  await heldReply.deliver()
  await expect(page.locator('.bubble__quote')).toContainText('@bobby')
  await expect(page.locator('.bubble__quote')).not.toContainText('<@user:')
  await bubble.getByRole('button', { name: '预览 photo.jpeg' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog').locator('img')).toHaveAttribute('src', /\/preview$/)
  const originalUrl = await page.getByRole('dialog').locator('a[download]').getAttribute('href')
  if (!originalUrl) throw new Error('missing download link')
  const imageDownload = await request.get(originalUrl)
  expect(imageDownload.status()).toBe(200)
  expect(imageDownload.headers()['content-type']).toBe('image/webp')
  expect(imageDownload.headers()['content-disposition']).toMatch(/^inline;/)
  expect(imageDownload.headers()['x-content-type-options']).toBe('nosniff')
  expect(imageDownload.headers()['content-security-policy']).toContain('sandbox')
  expect(imageDownload.headers()['cache-control']).toBe('private, no-store')
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('dialog').locator('a[download]').click()
  expect((await downloadEvent).suggestedFilename()).toBe('photo.jpeg')
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('dialog').locator('img')).toHaveAttribute('alt', 'motion.gif')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await openDetails(page)
  await expect(page.locator('.shared-files .attachment-grid img')).toHaveCount(2)
  await expect(page.locator('.shared-files')).toContainText('notes.txt')
  const context = await newContext(browser)
  const b = await context.newPage()
  await signIn(b, bob.email, bob.password)
  await b.goto(`/c/${id}`)
  await expect(b.locator('.mention[data-self=true]')).toHaveText('@bobby')
  const response = await request.get(`/api/conversations/${id}/messages`)
  const message = (await response.json()).messages.find(
    (m: { attachments: unknown[] }) => m.attachments.length === 3,
  )
  expect(message).toBeTruthy()
  const recalled = await request.post(`/api/messages/${message.id}/recall`, {
    headers: { origin: 'http://localhost:4174' },
    data: { expectedChangeSeq: message.changeSeq },
  })
  expect(recalled.ok()).toBe(true)
  await expect(b.locator('.attachment-grid img')).toHaveCount(0)
  await expect(page.locator('.shared-files .file-card')).toHaveCount(0)
  await context.close()
})

test('avatar crop and a real video player survive reload', async ({ page, request }) => {
  const person = people()[2]
  if (!person) throw new Error('fixtures missing')
  await signedIn(request, person)
  const id = await group(request, `媒体 ${Date.now()}`)
  await signIn(page, person.email, person.password)
  await page.goto(`/c/${id}`)
  await openDetails(page)
  await page.locator('.avatar-editor input[type=file]').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: readFileSync(resolve(directory, 'png.input')),
  })
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect
    .poll(() =>
      page.locator('.avatar-crop img').evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0)
  const heldAvatar = await holdRequest(
    page,
    /\/api\/uploads\/reservations$/,
    'POST',
    (body) => (JSON.parse(body ?? '{}') as { name?: string }).name === 'avatar.png',
  )
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
  await heldAvatar.requested
  const current = await (await request.get(`/api/conversations/${id}`)).json()
  const renamed = await request.patch(`/api/conversations/${id}`, {
    headers: { origin: 'http://localhost:4174' },
    data: { name: `上传时改名 ${Date.now()}`, expectedMetadataVersion: current.metadataVersion },
  })
  expect(renamed.ok()).toBe(true)
  await heldAvatar.sendToServer()
  await heldAvatar.deliver()
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 })
  await expect(page.locator('.details .avatar img')).toBeVisible()
  await page.locator('.composer input[type=file]').setInputFiles({
    name: 'movie.mp4',
    mimeType: 'video/mp4',
    buffer: readFileSync(resolve(directory, 'video.input')),
  })
  await expect(page.locator('.composer__send')).toBeEnabled({ timeout: 60_000 })
  await composer(page).press('Enter')
  await expect(page.locator('.msg-article video')).toBeVisible()
  await expect(page.locator(`[data-conversation-id="${id}"] .s-item__preview`)).toContainText(
    '[视频]',
  )
  await expect
    .poll(() =>
      page.locator('.msg-article video').evaluate((el: HTMLVideoElement) => el.readyState),
    )
    .toBeGreaterThan(0)
  await page.reload()
  await expect(page.locator('.msg-article video')).toBeVisible()
  await page.locator('.composer input[type=file]').setInputFiles({
    name: 'uncleared.mkv',
    mimeType: 'video/x-matroska',
    buffer: readFileSync(resolve(directory, 'ffv1.input')),
  })
  await expect(page.locator('.composer__send')).toBeEnabled({ timeout: 60_000 })
  await composer(page).press('Enter')
  const fallback = page.locator('.msg-article .file-card').filter({ hasText: 'uncleared.mkv' })
  await expect(fallback).toContainText('元数据未清理')
  await expect(page.locator(`[data-conversation-id="${id}"] .s-item__preview`)).toContainText(
    '[文件]',
  )
  expect(await page.locator('.msg-article video').count()).toBe(1)
  const downloaded = page.waitForEvent('download')
  await fallback.click()
  expect((await downloaded).suggestedFilename()).toBe('uncleared.mkv')
})

test('paste and drop files, emoji insertion, audio playback, download and upload cancellation', async ({
  page,
  request,
}) => {
  const person = people()[3]
  if (!person) throw new Error('fixtures missing')
  await signedIn(request, person)
  const id = await group(request, `剪贴板 ${Date.now()}`)
  await signIn(page, person.email, person.password)
  await page.goto(`/c/${id}`)
  await expect(composer(page)).toBeVisible()
  const data = [...readFileSync(resolve(directory, 'png.input'))]
  await composer(page).evaluate((field, bytes) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(bytes)], 'pasted.png', { type: 'image/png' }))
    field.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }),
    )
  }, data)
  await expect(page.locator('.upload-draft')).toHaveCount(1)
  await page.locator('.composer').evaluate((field) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['dropped content'], 'drop.txt', { type: 'text/plain' }))
    field.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
    )
  })
  await expect(page.locator('.upload-draft')).toHaveCount(2)
  await page.getByRole('button', { name: '表情', exact: true }).click()
  await page.locator('.emoji-picker button').first().click()
  await expect(composer(page)).not.toHaveValue('')
  await expect(page.locator('.composer__send')).toBeEnabled({ timeout: 60_000 })
  await composer(page).press('Enter')
  await expect(page.locator('.msg-article .attachment-grid img')).toHaveCount(1)
  const download = page.waitForEvent('download')
  await page.locator('.msg-article .file-card').click()
  expect((await download).suggestedFilename()).toBe('drop.txt')
  const wav = Buffer.alloc(44 + 16000)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(16000, 40)
  await page
    .locator('.composer input[type=file]')
    .setInputFiles({ name: 'sound.wav', mimeType: 'audio/wav', buffer: wav })
  await expect(page.locator('.composer__send')).toBeEnabled({ timeout: 60_000 })
  await composer(page).press('Enter')
  await expect(page.locator('.msg-article audio')).toBeVisible()
  await expect
    .poll(() =>
      page
        .locator('.msg-article audio')
        .evaluate((element: HTMLAudioElement) => element.readyState),
    )
    .toBeGreaterThan(0)
  const reserved = page.waitForResponse(
    (reply) =>
      reply.url().endsWith('/api/uploads/reservations') && reply.request().method() === 'POST',
  )
  await page.locator('.composer input[type=file]').setInputFiles({
    name: 'cancel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('cancel this draft'),
  })
  const uploadId = (await (await reserved).json()).uploadId as string
  await expect(page.locator('.upload-draft')).toHaveCount(1)
  const cancelled = page.waitForResponse(
    (reply) =>
      reply.request().method() === 'DELETE' && reply.url().endsWith(`/api/uploads/${uploadId}`),
  )
  await page.locator('.upload-draft').getByRole('button', { name: '取消', exact: true }).click()
  expect((await cancelled).ok()).toBe(true)
  await expect(page.locator('.upload-draft')).toHaveCount(0)
  const state = await request.get(`/api/uploads/${uploadId}`)
  expect((await state.json()).status).toBe('deleting')
})
