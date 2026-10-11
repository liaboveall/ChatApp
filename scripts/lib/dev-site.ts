import { isReserved, suggestPort, type WindowsPorts } from './ports.ts'

const PORTS = { web: 5173, pwa: 25173 } as const

/** Keep the PWA and HMR origins separate, including when Windows prevents localhost forwarding. */
export function developmentSite(mode: keyof typeof PORTS, windows: WindowsPorts | null) {
  const requested = PORTS[mode]
  const reservation = isReserved(requested, windows)
  const pwaPort = isReserved(PORTS.pwa, windows)
    ? suggestPort(25175, windows, [PORTS.web])
    : PORTS.pwa
  const port =
    mode === 'pwa'
      ? pwaPort
      : reservation
        ? suggestPort(25174, windows, [PORTS.web, pwaPort])
        : requested
  return { requested, reservation, port, origin: `http://localhost:${port}` }
}
