/** Small crypto helpers on node:crypto (portable across runtimes). Secrets never pass through logs. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** A random token as base64url; 32 bytes (256 bits) gives 43 characters. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export type SealedValue = { ciphertext: string; nonce: string; keyVersion: number }

export const CURRENT_KEY_VERSION = 1

/**
 * AES-256-GCM. `aad` (for example the owning row id) is authenticated but not stored, so a ciphertext copied to
 * another row fails to decrypt. The 16-byte tag is appended to the ciphertext.
 */
export function seal(key: Uint8Array, plaintext: string, aad: string): SealedValue {
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(aad))
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return {
    ciphertext: body.toString('base64url'),
    nonce: nonce.toString('base64url'),
    keyVersion: CURRENT_KEY_VERSION,
  }
}

export function open(
  key: Uint8Array,
  sealed: Omit<SealedValue, 'keyVersion'>,
  aad: string,
): string {
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes')
  const body = Buffer.from(sealed.ciphertext, 'base64url')
  if (body.length < 16) throw new Error('ciphertext too short')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64url'))
  decipher.setAAD(Buffer.from(aad))
  decipher.setAuthTag(body.subarray(body.length - 16))
  return Buffer.concat([
    decipher.update(body.subarray(0, body.length - 16)),
    decipher.final(),
  ]).toString('utf8')
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 without padding, uppercase: 5 bits per character, so 10 bytes give exactly 16 characters. */
export function randomBase32(bytes: number): string {
  const data = randomBytes(bytes)
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Keyed digest for values that must not appear in clear in Valkey keys (rate-limit subjects, for example). */
export function hmacSha256Hex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex')
}

/** `payload.signature`, both base64url: a value the client can hold but not change (pagination cursors). */
export function signPayload(key: Uint8Array, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const mac = createHmac('sha256', key).update(body).digest('base64url')
  return `${body}.${mac}`
}

/** The payload of a token made by `signPayload` under the same key, or null for anything else (bad shape, tampered, wrong key). */
export function verifyPayload(key: Uint8Array, token: string): unknown {
  const parts = token.split('.')
  const [body, mac] = parts
  if (parts.length !== 2 || !body || !mac) return null
  const expected = createHmac('sha256', key).update(body).digest('base64url')
  if (!constantTimeEqual(mac, expected)) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/** A fingerprint of a request: key order does not matter, so the same fields always give the same hash (D-066). */
export function fingerprint(value: unknown): string {
  return sha256Hex(JSON.stringify(sortKeys(value)))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    )
  }
  return value
}

/** Fixed namespace of this application's name-based ids (random, never reused for another purpose). */
export const CHATAPP_UUID_NAMESPACE = '0b3f6f6e-5d2c-4f0a-9d6e-6c1a2f4e8b71'

/**
 * RFC 4122 version 5 (SHA-1, name-based) UUID: the same name always gives the same id. Used where a retried effect must
 * land on the row it created the first time, for example the clientId of a message the assistant sends.
 */
export function uuidV5(name: string, namespace: string = CHATAPP_UUID_NAMESPACE): string {
  const space = Buffer.from(namespace.replaceAll('-', ''), 'hex')
  if (space.length !== 16) throw new Error('namespace must be a UUID')
  const hash = createHash('sha1').update(space).update(name, 'utf8').digest()
  const bytes = hash.subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
