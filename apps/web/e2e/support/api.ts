/**
 * API-level helpers for test set-up. Tests that are about a screen create their people here, quickly, and then use the
 * interface for what is being tested. Registration goes through the real endpoints: invitation, sign-up, the email from
 * Mailpit, verification.
 */
import { type APIRequestContext, request } from '@playwright/test'
import { adminCredentials, fakeClientIp, newPerson } from './accounts.ts'
import { deleteMail, linkIn, waitForMail } from './mailpit.ts'

const ORIGIN = 'http://localhost:4173'

/** A request context that looks like the app's own page: same origin header, its own client address. */
export async function apiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: ORIGIN,
    extraHTTPHeaders: {
      origin: ORIGIN,
      'x-forwarded-for': fakeClientIp(),
      accept: 'application/json',
    },
  })
}

let cachedAdmin: APIRequestContext | undefined

/** The administrator, signed in once per worker (sign-in attempts per account are limited). */
async function admin(): Promise<APIRequestContext> {
  if (cachedAdmin) return cachedAdmin
  const context = await apiContext()
  const { email, password } = adminCredentials()
  const response = await context.post('/api/auth/sign-in/email', { data: { email, password } })
  if (!response.ok()) throw new Error(`administrator sign-in failed: ${response.status()}`)
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
