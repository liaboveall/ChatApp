/**
 * A push service for tests: the real endpoint policy (with a resolver the test controls), and a sender that records what
 * the domain asked it to send and answers as scripted. Nothing here touches the network.
 */
import { createECDH, randomBytes } from 'node:crypto'
import type { PushPayload } from '@chatapp/contracts'
import type { Deps } from '../../src/domain/deps.ts'
import type { PushPorts } from '../../src/domain/push.ts'
import { claimReadyWork } from '../../src/domain/work-queue.ts'
import { processPushJob } from '../../src/jobs/push.ts'
import { silentLogger } from '../../src/lib/logger.ts'
import type { PresenceStore } from '../../src/realtime/presence.ts'
import type {
  PushMessage,
  PushOutcome,
  PushSender,
  PushService,
  PushTarget,
} from '../../src/runtime/push.ts'
import { createEndpointPolicy, type Resolved } from '../../src/runtime/push-endpoints.ts'
import { b64u, generateVapidKeys } from '../../src/runtime/web-push.ts'

export type SentPush = { target: PushTarget; message: PushMessage }

export type FakePush = {
  service: PushService
  /** Everything handed to the sender, oldest first. */
  sent: SentPush[]
  /** The payloads only. */
  payloads: () => PushPayload[]
  /** Answers each send: `delivered` unless a test says otherwise. */
  respond: (
    answer: (target: PushTarget, message: PushMessage) => PushOutcome | Promise<PushOutcome>,
  ) => void
  /** What the name of a host resolves to; public by default. */
  resolve: (answer: (hostname: string) => Resolved[]) => void
  reset: () => void
}

const PUBLIC: Resolved[] = [{ address: '142.250.80.74', family: 4 }]

export function fakePush(): FakePush {
  const sent: SentPush[] = []
  let answer: (target: PushTarget, message: PushMessage) => PushOutcome | Promise<PushOutcome> =
    () => ({
      kind: 'delivered',
      status: 201,
    })
  let resolver: (hostname: string) => Resolved[] = () => PUBLIC
  const sender: PushSender = {
    async send(target, message) {
      sent.push({ target, message })
      return answer(target, message)
    },
  }
  return {
    service: {
      vapidPublicKey: generateVapidKeys().publicKey,
      policy: createEndpointPolicy({ lookup: async (hostname) => resolver(hostname) }),
      sender,
    },
    sent,
    payloads: () => sent.map((entry) => entry.message.payload),
    respond: (next) => {
      answer = next
    },
    resolve: (next) => {
      resolver = next
    },
    reset: () => {
      sent.length = 0
      answer = () => ({ kind: 'delivered', status: 201 })
      resolver = () => PUBLIC
    },
  }
}

/** A browser's subscription keys, with the private half so a test can read what was sent. */
export function browserKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = randomBytes(16)
  return {
    p256dh: b64u.encode(ecdh.getPublicKey()),
    auth: b64u.encode(auth),
    receiver: { privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth },
  }
}

export const endpointOf = (name = 'one'): string =>
  `https://fcm.googleapis.com/fcm/send/${name}-${crypto.randomUUID()}`

/**
 * Runs every push task that is ready, the way the worker does: lease, begin, do, complete. `viewing` says which
 * conversations a person is looking at. Repeats until nothing is left, because deriving makes new tasks; `rounds: 1` runs
 * only what is ready now, which is how a test stops between deriving and delivering.
 */
export async function drainPush(
  deps: Deps,
  options: { viewing?: PushPorts['viewing']; rounds?: number } = {},
): Promise<number> {
  const presence = {
    viewing: options.viewing ?? (async () => false),
  } as unknown as PresenceStore
  let ran = 0
  for (let round = 0; round < (options.rounds ?? 10); round += 1) {
    const claimed = await claimReadyWork(deps, { limit: 200, kinds: ['push'] })
    if (claimed.length === 0) return ran
    for (const work of claimed) {
      await processPushJob(
        { deps, presence, log: silentLogger },
        { workId: work.id, leaseEpoch: work.leaseEpoch },
      )
      ran += 1
    }
  }
  return ran
}
