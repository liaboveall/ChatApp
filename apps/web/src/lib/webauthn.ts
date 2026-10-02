/**
 * Passkey ceremonies with the browser's own WebAuthn JSON support (`parseCreationOptionsFromJSON`,
 * `parseRequestOptionsFromJSON`, `credential.toJSON()`): the server's WebAuthn library speaks exactly that JSON, so no
 * client library is needed. The challenge is bound to a signed cookie that the browser sends back by itself.
 */
import { z } from 'zod'
import { api } from './api.ts'

type WebAuthnStatic = typeof PublicKeyCredential & {
  parseCreationOptionsFromJSON?: (options: unknown) => PublicKeyCredentialCreationOptions
  parseRequestOptionsFromJSON?: (options: unknown) => PublicKeyCredentialRequestOptions
}

export function passkeysSupported(): boolean {
  if (typeof window === 'undefined' || !('PublicKeyCredential' in window)) return false
  const credential = window.PublicKeyCredential as WebAuthnStatic
  return (
    typeof credential.parseCreationOptionsFromJSON === 'function' &&
    typeof credential.parseRequestOptionsFromJSON === 'function'
  )
}

export type PasskeyFailure = 'cancelled' | 'unsupported' | 'failed'

/** Maps what the browser throws to something the UI can phrase. The user dismissing the dialog is not an error. */
export function classifyPasskeyError(error: unknown): PasskeyFailure {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') return 'cancelled'
    if (error.name === 'NotSupportedError' || error.name === 'SecurityError') return 'unsupported'
  }
  return 'failed'
}

type CredentialJSON = { toJSON: () => Record<string, unknown> }

const optionsSchema = z.record(z.string(), z.unknown())

/** Asks the browser for an assertion with the server's challenge and sends it back; the answer sets the session cookie. */
export async function signInWithPasskey(): Promise<void> {
  const options = await api('/api/auth/passkey/generate-authenticate-options', {
    anonymous: true,
    schema: optionsSchema,
  })
  const parse = (window.PublicKeyCredential as WebAuthnStatic).parseRequestOptionsFromJSON
  if (!parse) throw new DOMException('Passkeys are not supported', 'NotSupportedError')
  const credential = (await navigator.credentials.get({
    publicKey: parse.call(window.PublicKeyCredential, options),
  })) as (Credential & CredentialJSON) | null
  if (!credential) throw new DOMException('No credential returned', 'NotAllowedError')
  await api('/api/auth/passkey/verify-authentication', {
    method: 'POST',
    json: { response: credential.toJSON() },
    anonymous: true,
  })
}

/** Creates a passkey for the signed-in account: options from the server, the authenticator ceremony, then the proof. */
export async function addPasskey(name?: string): Promise<void> {
  const query = name ? `?${new URLSearchParams({ name })}` : ''
  const options = await api(`/api/auth/passkey/generate-register-options${query}`, {
    schema: optionsSchema,
  })
  const parse = (window.PublicKeyCredential as WebAuthnStatic).parseCreationOptionsFromJSON
  if (!parse) throw new DOMException('Passkeys are not supported', 'NotSupportedError')
  const credential = (await navigator.credentials.create({
    publicKey: parse.call(window.PublicKeyCredential, options),
  })) as (Credential & CredentialJSON) | null
  if (!credential) throw new DOMException('No credential returned', 'NotAllowedError')
  await api('/api/auth/passkey/verify-registration', {
    method: 'POST',
    json: { response: credential.toJSON(), ...(name ? { name } : {}) },
    schema: z.unknown(),
  })
}

/** What the settings page shows about a passkey. Public keys and credential ids never reach the UI. */
export const passkeySchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  createdAt: z.coerce.date().nullish(),
  deviceType: z.string().nullish(),
  backedUp: z.boolean().nullish(),
})
export type Passkey = z.infer<typeof passkeySchema>

export function listPasskeys(signal?: AbortSignal): Promise<Passkey[]> {
  return api('/api/auth/passkey/list-user-passkeys', { schema: z.array(passkeySchema), signal })
}

export async function renamePasskey(id: string, name: string): Promise<void> {
  await api('/api/auth/passkey/update-passkey', {
    method: 'POST',
    json: { id, name },
    schema: z.unknown(),
  })
}

export async function deletePasskey(id: string): Promise<void> {
  await api('/api/auth/passkey/delete-passkey', {
    method: 'POST',
    json: { id },
    schema: z.unknown(),
  })
}
