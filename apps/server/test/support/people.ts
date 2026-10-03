/**
 * People for HTTP tests: an active account, signed in through the real login endpoint, with a small client that keeps
 * its cookie jar. Replies carry the status and the parsed JSON body (or null).
 */
import { expect } from 'bun:test'
import type { Conversation } from '@chatapp/contracts'
import { createActiveUser } from './deps.ts'
import type { CookieJar, TestApp } from './http.ts'

export type Reply<T = unknown> = { status: number; body: T; headers: Headers }

export type Person = {
  id: string
  username: string
  email: string
  password: string
  jar: CookieJar
  get: <T = unknown>(path: string, headers?: Record<string, string>) => Promise<Reply<T>>
  post: <T = unknown>(
    path: string,
    json?: unknown,
    headers?: Record<string, string>,
  ) => Promise<Reply<T>>
  patch: <T = unknown>(path: string, json: unknown) => Promise<Reply<T>>
  del: <T = unknown>(path: string) => Promise<Reply<T>>
}

export type ErrorBody = {
  error: { code: string; message: string; details?: Record<string, unknown> }
}

export async function person(
  app: TestApp,
  username: string,
  options: { role?: 'user' | 'admin' } = {},
): Promise<Person> {
  const account = await createActiveUser(app.services.deps, { username, role: options.role })
  const jar = app.newJar()
  const login = await app.request('/api/auth/sign-in/email', {
    json: { email: account.email, password: account.password },
    jar,
  })
  expect(login.status).toBe(200)

  const call = async <T>(
    method: string,
    path: string,
    json?: unknown,
    headers?: Record<string, string>,
  ): Promise<Reply<T>> => {
    const response = await app.request(path, {
      method,
      jar,
      headers,
      ...(json === undefined ? {} : { json }),
    })
    const text = await response.text()
    return {
      status: response.status,
      body: (text ? JSON.parse(text) : null) as T,
      headers: response.headers,
    }
  }
  return {
    id: account.id,
    username,
    email: account.email,
    password: account.password,
    jar,
    get: (path, headers) => call('GET', path, undefined, headers),
    post: (path, json, headers) => call('POST', path, json, headers),
    patch: (path, json) => call('PATCH', path, json),
    del: (path) => call('DELETE', path),
  }
}

export const key = (): { 'idempotency-key': string } => ({ 'idempotency-key': crypto.randomUUID() })

/** Creates a conversation through the API and returns it; fails the test if the API refuses. */
export async function createConversation(
  who: Person,
  input: { kind: 'channel' | 'group'; name: string; memberIds?: string[]; description?: string },
): Promise<Conversation> {
  const reply = await who.post<Conversation>('/api/conversations', input, key())
  expect(reply.status).toBe(201)
  return reply.body
}

export async function openDm(who: Person, other: Person): Promise<Conversation> {
  const reply = await who.post<Conversation>('/api/conversations/dm', { userId: other.id })
  expect([200, 201]).toContain(reply.status)
  return reply.body
}

export const errorCode = (reply: Reply): string | undefined =>
  (reply.body as ErrorBody | null)?.error?.code
export const errorReason = (reply: Reply): unknown =>
  (reply.body as ErrorBody | null)?.error?.details?.reason
