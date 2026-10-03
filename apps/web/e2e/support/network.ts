import type { Page, WebSocketRoute } from '@playwright/test'

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

export type Network = {
  /** Closes the open connection, fails HTTP, and refuses reconnection attempts until `goOnline`. */
  goOffline(): Promise<void>
  goOnline(): Promise<void>
  /** Connections that reached the real server and are still open. */
  connections(): number
  /** Reconnection attempts that were refused while offline. */
  refused(): number
}

export async function controlNetwork(page: Page): Promise<Network> {
  const live = new Set<WebSocketRoute>()
  let offline = false
  let refused = 0
  await page.routeWebSocket(/\/ws$/, (route) => {
    if (offline) {
      refused += 1
      void route.close({ code: DROPPED, reason: 'offline' })
      return
    }
    route.connectToServer()
    live.add(route)
    route.onClose(() => live.delete(route))
  })
  return {
    async goOffline() {
      offline = true
      await page.context().setOffline(true)
      await Promise.all([...live].map((route) => route.close({ code: DROPPED, reason: 'offline' })))
    },
    async goOnline() {
      offline = false
      await page.context().setOffline(false)
    },
    connections: () => live.size,
    refused: () => refused,
  }
}
