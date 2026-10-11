/**
 * Installing the app as a window of its own (docs/01 section 3.5, M6). Chromium browsers offer the install through an
 * event the page can keep and use from its own button; Safari and Firefox have their own menus and offer nothing to the
 * page, so there the settings only say where to look.
 */
import { create } from 'zustand'

type InstallEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type InstallState = { offer: InstallEvent | null; installed: boolean }

export const useInstall = create<InstallState>()(() => ({ offer: null, installed: false }))

/** Starts listening; call once at start-up. The offer is kept until the person takes it or the browser withdraws it. */
export function watchInstall(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    useInstall.setState({ offer: event as InstallEvent })
  })
  window.addEventListener('appinstalled', () =>
    useInstall.setState({ offer: null, installed: true }),
  )
}

/** Asks the browser to show its install dialog. Returns whether the person accepted. */
export async function promptInstall(): Promise<boolean> {
  const { offer } = useInstall.getState()
  if (!offer) return false
  await offer.prompt()
  const choice = await offer.userChoice
  // An offer can be used once.
  useInstall.setState({ offer: null })
  return choice.outcome === 'accepted'
}

/** Whether the page is running as an installed app now. */
export const isInstalledApp = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: window-controls-overlay)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true
