/**
 * API-level helpers for test set-up. Tests that are about a screen create their people here, quickly, and then use the
 * interface for what is being tested. Registration goes through the real endpoints: invitation, sign-up, the email from
 * Mailpit, verification.
 */
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { type APIRequestContext, request } from '@playwright/test'
import { adminCredentials, fakeClientIp, newPerson } from './accounts.ts'
import { deleteMail, linkIn, waitForMail } from './mailpit.ts'

/** The site under test: the preview server by default; the edge suite points it at the gateway. */
const ORIGIN = process.env.E2E_ORIGIN ?? 'http://localhost:4173'

/** A request context that looks like the app's own page: same origin header, its own client address. */
export async function apiContext(storageState?: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: ORIGIN,
    ignoreHTTPSErrors: true,
    storageState,
    extraHTTPHeaders: {
      origin: ORIGIN,
      'x-forwarded-for': fakeClientIp(),
      accept: 'application/json',
    },
  })
}

let cachedAdmin: APIRequestContext | undefined

/**
 * Where the administrator's session is kept for the length of one run. Playwright starts a new worker after every test
 * that fails, and a worker that signed in again each time would soon meet the limit on sign-in attempts per account (429),
 * which turns one failure into dozens. All the workers of a run share one parent, the runner, so its process number names
 * the run; the directory is emptied when the next run starts.
 */
const SESSION_FILE = path.join('test-results', `.administrator-session-${process.ppid}.json`)

/** The administrator, signed in once per run (sign-in attempts per account are limited). */
async function admin(): Promise<APIRequestContext> {
  if (cachedAdmin) return cachedAdmin
  if (existsSync(SESSION_FILE)) {
    const kept = await apiContext(SESSION_FILE)
    if ((await kept.get('/api/me')).ok()) {
      cachedAdmin = kept
      return kept
    }
    await kept.dispose()
  }
  const context = await apiContext()
  const { email, password } = adminCredentials()
  const response = await context.post('/api/auth/sign-in/email', { data: { email, password } })
  if (!response.ok()) throw new Error(`administrator sign-in failed: ${response.status()}`)
  await mkdir(path.dirname(SESSION_FILE), { recursive: true })
  await context.storageState({ path: SESSION_FILE })
  cachedAdmin = context
  return context
}

/** A one-use invitation code from the administrator. */
export async function createInviteCode(): Promise<string> {
  const response = await (await admin()).post('/api/invites', { data: { note: 'e2e' } })
  if (!response.ok()) throw new Error(`invite creation failed: ${response.status()}`)
  return ((await response.json()) as { code: string }).code
}

export type Person = ReturnType<typeof newPerson>

/** Registers a member through the API and leaves the address unverified; the verification mail stays in Mailpit. */
export async function registerMember(
  label = 'member',
): Promise<{ person: Person; startedAt: number; context: APIRequestContext }> {
  const person = newPerson(label)
  const context = await apiContext()
  const startedAt = Date.now()
  const signUp = await context.post('/api/auth/sign-up/email', {
    headers: { 'x-invite-code': await createInviteCode(), 'idempotency-key': crypto.randomUUID() },
    data: {
      email: person.email,
      username: person.username,
      name: person.name,
      password: person.password,
    },
  })
  if (!signUp.ok()) throw new Error(`sign-up failed: ${signUp.status()}`)
  return { person, startedAt, context }
}

/** Registers and verifies a member through the API. Returns the person, ready to sign in. */
export async function createVerifiedMember(label = 'member'): Promise<Person> {
  const { person, startedAt, context } = await registerMember(label)
  const mail = await waitForMail(person.email, startedAt - 2_000)
  const { token } = linkIn(mail, '/verify-email')
  const verify = await context.post('/api/auth/verification/consume', { data: { token } })
  if (!verify.ok()) throw new Error(`verification failed: ${verify.status()}`)
  await deleteMail(mail.id)
  await context.dispose()
  return person
}
