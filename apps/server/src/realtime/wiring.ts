/**
 * The one place that connects a gateway to the event bus, shared by the API process and the tests so they cannot drift:
 * events go in, and whenever the bus comes back after an absence the gateway looks at the database again, because every
 * hint published while it was away is gone (docs/03 section 5.7, AT-02).
 */
import type { EventBus } from './bus.ts'
import type { Gateway } from './gateway.ts'

/** Returns a function that disconnects them again. */
export async function connectGatewayToBus(
  bus: EventBus,
  gateway: Gateway,
): Promise<() => Promise<void>> {
  const unsubscribe = await bus.subscribe((event) => gateway.handleEvent(event))
  const stopListening = bus.onReconnect(() => {
    void gateway.afterBusRecovered().catch(() => undefined)
  })
  return async () => {
    stopListening()
    await unsubscribe()
  }
}
