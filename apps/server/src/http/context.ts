/**
 * Types shared by the HTTP layer. Bun specifics (the peer address) arrive through `Bindings` from the composition root,
 * so nothing under http/ references Bun (D-090).
 */
import type { Auth } from '../auth/better-auth.ts'
import type { Config } from '../config/index.ts'
import type { Deps } from '../domain/deps.ts'
import type { SessionPrincipal } from '../domain/principal.ts'
import type { createClientIpResolver } from '../lib/ip.ts'
import type { Logger } from '../lib/logger.ts'
import type { RateLimiter } from '../lib/rate-limit.ts'

export type HttpEnv = {
  Bindings: {
    /** Address of the connecting socket (set by api.ts from the server object). */
    peerAddress?: (request: Request) => string | undefined
  }
  Variables: {
    requestId: string
    clientIp: string
    principal: SessionPrincipal | undefined
    /** Static label for the access log when a catch-all handler served an allowlisted path. */
    routeLabel: string | undefined
    /** `Set-Cookie` lines from the SDK (session refresh) to attach to the response. */
    pendingCookies: string[]
  }
}

export type Services = {
  config: Config
  deps: Deps
  auth: Auth
  limiter: RateLimiter
  log: Logger
  resolveClientIp: ReturnType<typeof createClientIpResolver>
  /** Checks Postgres, Valkey and object storage; true only when all answer in time. */
  isReady: () => Promise<boolean>
  /** Best-effort hint that work was committed, so the dispatcher scans now instead of at its next tick. */
  wake: () => void
}
