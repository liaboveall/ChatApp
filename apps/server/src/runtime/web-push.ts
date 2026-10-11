/**
 * Web Push message encryption (RFC 8291, `aes128gcm` content coding of RFC 8188) and VAPID (RFC 8292), on `node:crypto`
 * alone (D-201). Only the standard primitives are used (ECDH P-256, HKDF-SHA-256, AES-128-GCM, ECDSA P-256), and the
 * implementation is checked against the test vector of RFC 8291 appendix A and by a receiving side written separately in
 * the tests. Nothing here touches the network: sending is `push-transport.ts`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto'

const RECORD_SIZE = 4096
const TAG_BYTES = 16
const P256_POINT_BYTES = 65

export const b64u = {
  encode: (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url'),
  decode: (text: string): Buffer => Buffer.from(text, 'base64url'),
}

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8')

function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length))
}

/** Whether a subscription's keys are usable: a real point on the P-256 curve and a 16-byte authentication secret. */
export function validSubscriptionKeys(keys: { p256dh: string; auth: string }): boolean {
  const point = b64u.decode(keys.p256dh)
  if (
    point.length !== P256_POINT_BYTES ||
    point[0] !== 0x04 ||
    b64u.decode(keys.auth).length !== 16
  ) {
    return false
  }
  try {
    const probe = createECDH('prime256v1')
    probe.generateKeys()
    // Computing a shared secret fails for a point that is not on the curve.
    probe.computeSecret(point)
    return true
  } catch {
    return false
  }
}

export type EncryptionKeys = {
  /** The sender's one-time key pair; its public half travels in the message (`keyid`). */
  senderPublic: Uint8Array
  senderPrivate: Uint8Array
  salt: Uint8Array
}

/** Fresh random keys for one message; tests pass fixed ones to reproduce the RFC vector. */
export function freshEncryptionKeys(): EncryptionKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    senderPublic: ecdh.getPublicKey(),
    senderPrivate: ecdh.getPrivateKey(),
    salt: randomBytes(16),
  }
}

/**
 * Encrypts `plaintext` for a browser's subscription keys into one `aes128gcm` record and returns the whole request body:
 * salt (16) | record size (4) | key id length (1) | sender public key (65) | ciphertext with its tag.
 */
export function encryptWebPush(
  plaintext: Uint8Array,
  subscription: { p256dh: string; auth: string },
  keys: EncryptionKeys = freshEncryptionKeys(),
): Buffer {
  const userPublic = b64u.decode(subscription.p256dh)
  const authSecret = b64u.decode(subscription.auth)
  if (userPublic.length !== P256_POINT_BYTES || userPublic[0] !== 0x04) {
    throw new Error('subscription key is not an uncompressed P-256 point')
  }
  if (authSecret.length !== 16) throw new Error('subscription auth secret must be 16 bytes')
  // One record holds the data, the delimiter byte and the tag; larger messages are not sent at all.
  if (plaintext.length > RECORD_SIZE - TAG_BYTES - 1) throw new Error('push payload too large')

  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(keys.senderPrivate))
  const shared = ecdh.computeSecret(userPublic)

  // RFC 8291 section 3.4: the auth secret keys the first extraction, binding the message to this subscription.
  const keyInfo = Buffer.concat([
    utf8('WebPush: info\0'),
    userPublic,
    Buffer.from(keys.senderPublic),
  ])
  const ikm = hkdf(authSecret, shared, keyInfo, 32)
  const cek = hkdf(keys.salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(keys.salt, ikm, utf8('Content-Encoding: nonce\0'), 12)

  // RFC 8188: the last (here the only) record ends with the delimiter 0x02.
  const record = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])])
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const encrypted = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(16 + 4 + 1)
  Buffer.from(keys.salt).copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(keys.senderPublic.length, 20)
  return Buffer.concat([header, Buffer.from(keys.senderPublic), encrypted])
}

/**
 * The receiving side, as a browser does it. Used by the tests (and the end-to-end checks) to read what the server sent;
 * the server itself never decrypts anything.
 */
export function decryptWebPush(
  body: Uint8Array,
  receiver: { privateKey: Uint8Array; publicKey: Uint8Array; auth: Uint8Array },
): Buffer {
  const data = Buffer.from(body)
  const salt = data.subarray(0, 16)
  const recordSize = data.readUInt32BE(16)
  const idLength = data.readUInt8(20)
  const senderPublic = data.subarray(21, 21 + idLength)
  const encrypted = data.subarray(21 + idLength)
  if (recordSize < TAG_BYTES + 2 || encrypted.length > recordSize) {
    throw new Error('unsupported record size')
  }

  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(Buffer.from(receiver.privateKey))
  const shared = ecdh.computeSecret(senderPublic)
  const keyInfo = Buffer.concat([
    utf8('WebPush: info\0'),
    Buffer.from(receiver.publicKey),
    senderPublic,
  ])
  const ikm = hkdf(receiver.auth, shared, keyInfo, 32)
  const cek = hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(encrypted.subarray(encrypted.length - TAG_BYTES))
  const record = Buffer.concat([
    decipher.update(encrypted.subarray(0, encrypted.length - TAG_BYTES)),
    decipher.final(),
  ])
  // Strip zero padding, then the delimiter that closes the last record.
  let end = record.length
  while (end > 0 && record[end - 1] === 0) end -= 1
  if (end === 0 || record[end - 1] !== 0x02) throw new Error('missing final record delimiter')
  return record.subarray(0, end - 1)
}

// ───────── VAPID (RFC 8292) ─────────

export type VapidKeys = { publicKey: string; privateKey: string; subject: string }

/** A fresh application server key pair, as base64url strings (public: 65-byte point; private: 32-byte scalar). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: b64u.encode(ecdh.getPublicKey()),
    privateKey: b64u.encode(ecdh.getPrivateKey()),
  }
}

/** The signing key object for ES256 from the raw scalar and point (PKCS#8 is not needed: a JWK carries both). */
function vapidSigningKey(keys: VapidKeys) {
  const point = b64u.decode(keys.publicKey)
  if (point.length !== P256_POINT_BYTES || point[0] !== 0x04) {
    throw new Error('VAPID public key is not an uncompressed P-256 point')
  }
  const d = b64u.decode(keys.privateKey)
  if (d.length !== 32) throw new Error('VAPID private key must be 32 bytes')
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u.encode(point.subarray(1, 33)),
      y: b64u.encode(point.subarray(33, 65)),
      d: b64u.encode(d),
    },
    format: 'jwk',
  })
}

/** Whether the private scalar really belongs to the public point; checked once at start-up. */
export function vapidKeysMatch(keys: VapidKeys): boolean {
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(b64u.decode(keys.privateKey))
    return ecdh.getPublicKey().equals(b64u.decode(keys.publicKey))
  } catch {
    return false
  }
}

const JWT_LIFETIME_SECONDS = 12 * 60 * 60

/** The `Authorization` value for one request (RFC 8292 section 3): `vapid t=<JWT>, k=<application server key>`. */
export function vapidAuthorization(keys: VapidKeys, endpointOrigin: string, nowMs: number): string {
  const header = b64u.encode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u.encode(
    utf8(
      JSON.stringify({
        aud: endpointOrigin,
        exp: Math.floor(nowMs / 1000) + JWT_LIFETIME_SECONDS,
        sub: keys.subject,
      }),
    ),
  )
  const signingInput = `${header}.${claims}`
  const signature = sign('sha256', utf8(signingInput), {
    key: vapidSigningKey(keys),
    dsaEncoding: 'ieee-p1363',
  })
  return `vapid t=${signingInput}.${b64u.encode(signature)}, k=${keys.publicKey}`
}

/** Checks a VAPID JWT the way a push service does: used by the tests to prove the header is acceptable. */
export function verifyVapidJwt(
  jwt: string,
  publicKey: string,
): { aud: string; exp: number; sub: string } | null {
  const [header, claims, signature] = jwt.split('.')
  if (!header || !claims || !signature) return null
  const point = b64u.decode(publicKey)
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64u.encode(point.subarray(1, 33)),
      y: b64u.encode(point.subarray(33, 65)),
    },
    format: 'jwk',
  })
  const ok = verify(
    'sha256',
    utf8(`${header}.${claims}`),
    { key, dsaEncoding: 'ieee-p1363' },
    b64u.decode(signature),
  )
  if (!ok) return null
  const parsed = JSON.parse(b64u.decode(claims).toString('utf8')) as {
    aud: string
    exp: number
    sub: string
  }
  return parsed
}
