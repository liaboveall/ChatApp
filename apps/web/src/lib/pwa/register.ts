/**
 * Registers the service worker (docs/07 SEC-06, D-146, D-206). The page enforces Trusted Types, and registering a worker takes a
 * script URL, which is one of the places a string is refused. So there is one policy, named `chatapp-sw`, that turns exactly
 * one string into a script URL: `/sw.js`. It cannot be used for anything else, and nothing else can create a policy.
 */

const POLICY_NAME = 'chatapp-sw'
export const WORKER_SCRIPT = '/sw.js'

type ScriptUrlPolicy = { createScriptURL(input: string): unknown }
type PolicyFactory = {
  createPolicy(name: string, rules: { createScriptURL: (input: string) => string }): ScriptUrlPolicy
}

let policy: ScriptUrlPolicy | undefined

/** The worker's address as the page's policy wants it: a Trusted Types URL where the browser has them, the string where not. */
export function workerUrl(): unknown {
  const factory = (window as { trustedTypes?: PolicyFactory }).trustedTypes
  if (!factory) return WORKER_SCRIPT
  policy ??= factory.createPolicy(POLICY_NAME, {
    createScriptURL: (input) => {
      if (input !== WORKER_SCRIPT) throw new TypeError('This policy only names the service worker')
      return input
    },
  })
  return policy.createScriptURL(WORKER_SCRIPT)
}

/** Whether this browser can run a service worker at all (it needs a secure context: https, or localhost). */
export const workersAvailable = (): boolean =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext

/**
 * Registers the worker once the page has settled. Development has no worker (the build makes it), so there is nothing to
 * register; a failure leaves the app working without an offline shell and without push, which are additions.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!import.meta.env.PROD || !workersAvailable()) return undefined
  try {
    return await navigator.serviceWorker.register(workerUrl() as string, { scope: '/' })
  } catch {
    return undefined
  }
}

/** The registration, if there is one; never waits for a worker that will not come (development, a failed registration). */
export async function currentRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!workersAvailable()) return undefined
  try {
    return await navigator.serviceWorker.getRegistration('/')
  } catch {
    return undefined
  }
}
