/**
 * The random id this browser made for itself (docs/05 section 3.7, D-203). It is what lets a new sign-in on the same browser
 * take over the push endpoint that a previous account left behind, and what stops anybody who only knows the endpoint from
 * doing it. It belongs to the device, not to an account, so it stays after a sign-out; it is never shown or sent anywhere
 * but to this server, with a subscription.
 */
import { local } from '@/lib/storage.ts'

const KEY = 'chatapp.installation'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function installationId(): string {
  const existing = local.get(KEY)
  if (existing !== null && UUID.test(existing)) return existing
  const made = crypto.randomUUID()
  local.set(KEY, made)
  return made
}
