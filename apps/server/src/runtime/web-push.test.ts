import { describe, expect, test } from 'bun:test'
import { createECDH } from 'node:crypto'
import {
  b64u,
  decryptWebPush,
  encryptWebPush,
  freshEncryptionKeys,
  generateVapidKeys,
  vapidAuthorization,
  vapidKeysMatch,
  verifyVapidJwt,
} from './web-push.ts'

// The example of RFC 8291 section 5 and appendix A, character for character.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  receiverPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

function receiver() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    privateKey: ecdh.getPrivateKey(),
    publicKey: ecdh.getPublicKey(),
    auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))),
  }
}

describe('RFC 8291 message encryption', () => {
  test('reproduces the RFC example exactly', () => {
    const body = encryptWebPush(
      Buffer.from(RFC.plaintext),
      { p256dh: RFC.receiverPublic, auth: RFC.authSecret },
      {
        senderPublic: b64u.decode(RFC.senderPublic),
        senderPrivate: b64u.decode(RFC.senderPrivate),
        salt: b64u.decode(RFC.salt),
      },
    )
    expect(b64u.encode(body)).toBe(RFC.body)
  })

  test('the receiving side reads the RFC example', () => {
    const plaintext = decryptWebPush(b64u.decode(RFC.body), {
      privateKey: b64u.decode(RFC.receiverPrivate),
      publicKey: b64u.decode(RFC.receiverPublic),
      auth: b64u.decode(RFC.authSecret),
    })
    expect(plaintext.toString('utf8')).toBe(RFC.plaintext)
  })

  test('a round trip with fresh keys, including multi-byte text', () => {
    const who = receiver()
    const subscription = { p256dh: b64u.encode(who.publicKey), auth: b64u.encode(who.auth) }
    const message = JSON.stringify({ title: '新消息', body: '你有新消息 ✦' })
    const body = encryptWebPush(Buffer.from(message), subscription)
    expect(decryptWebPush(body, who).toString('utf8')).toBe(message)
  })

  test('every message uses a new salt and a new sender key', () => {
    const who = receiver()
    const subscription = { p256dh: b64u.encode(who.publicKey), auth: b64u.encode(who.auth) }
    const one = encryptWebPush(Buffer.from('x'), subscription)
    const two = encryptWebPush(Buffer.from('x'), subscription)
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false)
    expect(one.subarray(21, 86).equals(two.subarray(21, 86))).toBe(false)
    expect(freshEncryptionKeys().salt.length).toBe(16)
  })

  test('another receiver cannot read it, and a changed byte is detected', () => {
    const who = receiver()
    const other = receiver()
    const subscription = { p256dh: b64u.encode(who.publicKey), auth: b64u.encode(who.auth) }
    const body = encryptWebPush(Buffer.from('secret'), subscription)
    expect(() => decryptWebPush(body, other)).toThrow()
    const tampered = Buffer.from(body)
    tampered.writeUInt8((tampered.readUInt8(tampered.length - 20) ^ 1) & 0xff, tampered.length - 20)
    expect(() => decryptWebPush(tampered, who)).toThrow()
  })

  test('refuses keys that are not a P-256 point and payloads that do not fit one record', () => {
    const who = receiver()
    const good = { p256dh: b64u.encode(who.publicKey), auth: b64u.encode(who.auth) }
    expect(() => encryptWebPush(Buffer.from('x'), { ...good, p256dh: 'AAAA' })).toThrow()
    expect(() => encryptWebPush(Buffer.from('x'), { ...good, auth: 'AAAA' })).toThrow()
    expect(() => encryptWebPush(Buffer.alloc(4079), good)).not.toThrow()
    expect(() => encryptWebPush(Buffer.alloc(4080), good)).toThrow('too large')
  })
})

describe('VAPID (RFC 8292)', () => {
  const keys = { ...generateVapidKeys(), subject: 'mailto:admin@example.test' }

  test('a generated key pair is consistent, a mismatched one is detected', () => {
    expect(vapidKeysMatch(keys)).toBe(true)
    expect(vapidKeysMatch({ ...keys, privateKey: generateVapidKeys().privateKey })).toBe(false)
    expect(vapidKeysMatch({ ...keys, publicKey: 'AAAA' })).toBe(false)
  })

  test('the Authorization header carries a JWT a push service can verify', () => {
    const now = Date.UTC(2026, 9, 9, 12, 0, 0)
    const header = vapidAuthorization(keys, 'https://push.example.net', now)
    const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(header)
    expect(match).not.toBeNull()
    const [, jwt, key] = match ?? []
    expect(key).toBe(keys.publicKey)
    const claims = verifyVapidJwt(jwt ?? '', keys.publicKey)
    expect(claims).toEqual({
      aud: 'https://push.example.net',
      exp: Math.floor(now / 1000) + 12 * 3600,
      sub: 'mailto:admin@example.test',
    })
    const head = JSON.parse(b64u.decode((jwt ?? '').split('.')[0] ?? '').toString('utf8'))
    expect(head).toEqual({ typ: 'JWT', alg: 'ES256' })
    // The signature is the raw 64-byte R||S form of a JWS, not DER.
    expect(b64u.decode((jwt ?? '').split('.')[2] ?? '').length).toBe(64)
  })

  test('a JWT does not verify under another key or after any change', () => {
    const header = vapidAuthorization(keys, 'https://push.example.net', 0)
    const jwt = /t=([\w.-]+),/.exec(header)?.[1] ?? ''
    expect(verifyVapidJwt(jwt, generateVapidKeys().publicKey)).toBeNull()
    const [h, c, s] = jwt.split('.')
    const forged = b64u.encode(
      Buffer.from(JSON.stringify({ aud: 'https://evil.example', exp: 9e9, sub: 'x' })),
    )
    expect(verifyVapidJwt(`${h}.${forged}.${s}`, keys.publicKey)).toBeNull()
    expect(verifyVapidJwt(`${h}.${c}`, keys.publicKey)).toBeNull()
  })

  test('refuses to sign with malformed keys', () => {
    expect(() =>
      vapidAuthorization({ ...keys, publicKey: 'AAAA' }, 'https://x.example', 0),
    ).toThrow()
    expect(() =>
      vapidAuthorization({ ...keys, privateKey: 'AAAA' }, 'https://x.example', 0),
    ).toThrow()
  })
})
