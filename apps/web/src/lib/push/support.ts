/**
 * Whether this browser can receive a push, and in what state the permission is (docs/01 section 4.8, M6). A push needs a
 * secure page, a service worker, the Push API and notifications; Safari on an iPhone or iPad only has them in an app added to
 * the home screen. Pure functions of the environment they are given, so every case is exercised without a browser.
 */

export type Unsupported =
  | 'insecure'
  | 'no-service-worker'
  | 'no-push'
  | 'no-notifications'
  | 'needs-install'
  | 'no-storage'

export type PushSupport = { supported: true } | { supported: false; reason: Unsupported }

export type Environment = {
  secure: boolean
  hasServiceWorker: boolean
  hasPush: boolean
  hasNotifications: boolean
  /** iPhone or iPad (including an iPad that says it is a Mac). */
  appleTouch: boolean
  /** Running as an installed app (home screen or app window). */
  standalone: boolean
  storage: boolean
}

export function supportFor(env: Environment): PushSupport {
  if (!env.secure) return { supported: false, reason: 'insecure' }
  if (!env.hasServiceWorker) return { supported: false, reason: 'no-service-worker' }
  if (env.appleTouch && !env.standalone) return { supported: false, reason: 'needs-install' }
  if (!env.hasPush) return { supported: false, reason: 'no-push' }
  if (!env.hasNotifications) return { supported: false, reason: 'no-notifications' }
  if (!env.storage) return { supported: false, reason: 'no-storage' }
  return { supported: true }
}

function storageWorks(): boolean {
  try {
    const key = 'chatapp.probe'
    localStorage.setItem(key, '1')
    localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

export function currentEnvironment(): Environment {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: window-controls-overlay)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  return {
    secure: window.isSecureContext,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPush: 'PushManager' in window,
    hasNotifications: 'Notification' in window,
    appleTouch:
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    standalone,
    storage: storageWorks(),
  }
}

export const pushSupport = (): PushSupport => supportFor(currentEnvironment())

/** The permission as the page can read it, or `unsupported` where notifications do not exist. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return 'Notification' in window ? Notification.permission : 'unsupported'
}

/** The key the server hands out is base64url; the Push API wants the bytes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(base64url.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false
  const left = new Uint8Array(a)
  return left.length === b.length && left.every((value, index) => value === b[index])
}
