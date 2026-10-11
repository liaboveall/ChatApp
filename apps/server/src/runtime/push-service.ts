/**
 * Builds the push port of `Deps` for a process (docs/03 section 7, M6). Production and development send over the pinned
 * HTTPS transport. APP_ENV=test swaps in the simulated push service of the end-to-end tests: names are not resolved (a fixed
 * public-looking answer stands in, so the suite needs no DNS) and nothing leaves the machine; each request is recorded in
 * Valkey, where the test reads it back and decrypts it the way a browser would (docs/08 scenario 9).
 */
import type { Config } from '../config/index.ts'
import type { Valkey } from '../lib/valkey.ts'
import {
  type CapturedPush,
  createCaptureTransport,
  createPushSender,
  type PushService,
} from './push.ts'
import { createEndpointPolicy } from './push-endpoints.ts'
import { createPinnedTransport } from './push-transport.ts'

/** Where the simulated push service keeps what it was asked to send (APP_ENV=test only). */
export const capturedPushKey = (env: string): string => `chatapp-${env}:push:captured`
/** A global-unicast address: the test policy needs *an* answer that passes the public-address check. */
const TEST_ANSWER = [{ address: '142.250.80.74', family: 4 as const }]

export function createPushService(config: Config, valkey: Valkey): PushService | undefined {
  if (!config.push) return undefined
  const isTest = config.env === 'test'
  const policy = createEndpointPolicy(isTest ? { lookup: async () => TEST_ANSWER } : {})
  const key = capturedPushKey(config.env)
  const transport = isTest
    ? createCaptureTransport({
        async push(entry: CapturedPush) {
          await valkey.rpush(key, JSON.stringify(entry))
          await valkey.expire(key, 3600)
        },
      })
    : createPinnedTransport({ policy })
  return {
    vapidPublicKey: config.push.publicKey,
    policy,
    sender: createPushSender({ vapid: config.push, transport, policy }),
  }
}
