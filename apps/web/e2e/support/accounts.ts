import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The administrator that `scripts/e2e-stack.ts` creates for the run (credentials file is mode 600, git-ignored). */
export function adminCredentials(): { email: string; username: string; password: string } {
  const path = fileURLToPath(new URL('../../../../.test-runs/e2e/admin.json', import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as {
    email: string
    username: string
    password: string
  }
}

let counter = 0

/** A new person for one test: unique name and email, a strong random password. */
export function newPerson(label = 'user'): {
  email: string
  username: string
  name: string
  password: string
} {
  counter += 1
  const stamp = `${Date.now().toString(36)}${counter}${Math.random().toString(36).slice(2, 5)}`
  const username = `${label}_${stamp}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20)
  return {
    email: `${username}@example.test`,
    username,
    name: `Test ${label}`,
    password: `Zq9-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}-lantern`,
  }
}

/** A fake client address per browser context, so the per-IP rate limits of one test never hit another (SEC-28). */
export function fakeClientIp(): string {
  counter += 1
  return `10.${(counter >> 8) & 255}.${counter & 255}.${1 + Math.floor(Math.random() * 250)}`
}
