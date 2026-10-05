import type { Page, WebSocketRoute } from '@playwright/test'
import { networkCut } from './fixtures.ts'

/**
 * Takes a browser off the network and puts it back (V-14, docs/12). `context.setOffline` is not enough on its own: in
 * Playwright 1.63 it leaves a WebSocket that is already open untouched in Chromium (traffic is held), WebKit and
 * Firefox (traffic flows as if nothing happened), and WebKit even opens new ones. So the two halves are done apart:
 * HTTP goes through `setOffline`; the WebSocket goes through `routeWebSocket`, which closes the established connection
 * from the page's side, refuses every attempt to reconnect while offline, and lets the next attempt through once back
 * online. It behaves the same in all three engines.
 *
 * Install it BEFORE the page opens its first socket (before signing in), because only sockets created after the route
 * is in place are routed. Server-side drops (a restart, a lost dependency) are `POST /api/test/realtime/disconnect`.
 */

/** The close code the page sees: in the 3000 range (the only ones a script may send besides 1000), not one the protocol reacts to. */
export const DROPPED = 3001

/** The server's hints about changes: all that the client's periodic reconciliation exists to make up for (AC-06). */
const HINTS = new Set([
  'message.changed',
  'conversation.changed',
  'member.changed',
  'user.changed',
  'conversation.removed',
])

export type Network = {
  /** Closes the open connection, fails HTTP, and refuses reconnection attempts until `goOnline`. */
  goOffline(): Promise<void>
  goOnline(): Promise<void>
  /**
   * Keeps the connection and HTTP working but swallows the hints the server sends (typing, presence, hello and pongs still
   * arrive): a client that depends on hints alone would never learn of anything.
   */
  muteHints(on: boolean): void
  /** Connections that reached the real server and are still open. */
  connections(): number
  /** Reconnection attempts that were refused while offline. */
  refused(): number
  /** Hints swallowed while muted. */
  droppedHints(): number
}

export async function controlNetwork(page: Page): Promise<Network> {
  const live = new Set<WebSocketRoute>()
  let offline = false
  let muted = false
  let refused = 0
  let dropped = 0
  await page.routeWebSocket(/\/ws$/, (route) => {
    if (offline) {
      refused += 1
      void route.close({ code: DROPPED, reason: 'offline' })
      return
    }
    const server = route.connectToServer()
    // Both directions are forwarded by hand so that the hints can be held back.
    server.onMessage((message) => {
      if (muted && typeof message === 'string') {
        try {
          const frame = JSON.parse(message) as { type?: unknown }
          if (typeof frame.type === 'string' && HINTS.has(frame.type)) {
            dropped += 1
            return
          }
        } catch {
          // Not JSON: not a hint.
        }
      }
      route.send(message)
    })
    route.onMessage((message) => server.send(message))
    live.add(route)
    route.onClose(() => live.delete(route))
  })
  return {
    async goOffline() {
      offline = true
      // The fixtures are told first: the files and fetches that fail from now on are the test's doing, not the page's.
      networkCut(page.context(), true)
      await page.context().setOffline(true)
      await Promise.all([...live].map((route) => route.close({ code: DROPPED, reason: 'offline' })))
    },
    async goOnline() {
      offline = false
      await page.context().setOffline(false)
      networkCut(page.context(), false)
    },
    muteHints(on) {
      muted = on
    },
    connections: () => live.size,
    refused: () => refused,
    droppedHints: () => dropped,
  }
}
