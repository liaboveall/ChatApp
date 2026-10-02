/**
 * Browser storage that never throws: private windows, blocked site data and quota errors all degrade to "nothing
 * stored" (the page must render correctly without it). Everything user-specific goes through `scopedKey`, so a different
 * account or a new login generation never reads another one's data (D-070, SEC-34).
 */

function safe<T>(action: () => T, fallback: T): T {
  try {
    return action()
  } catch {
    return fallback
  }
}

export const local = {
  get: (key: string): string | null => safe(() => localStorage.getItem(key), null),
  set: (key: string, value: string): void =>
    safe(() => localStorage.setItem(key, value), undefined),
  remove: (key: string): void => safe(() => localStorage.removeItem(key), undefined),
  keys: (): string[] =>
    safe(() => {
      const found: string[] = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i)
        if (key !== null) found.push(key)
      }
      return found
    }, []),
}

export const session = {
  get: (key: string): string | null => safe(() => sessionStorage.getItem(key), null),
  set: (key: string, value: string): void =>
    safe(() => sessionStorage.setItem(key, value), undefined),
  remove: (key: string): void => safe(() => sessionStorage.removeItem(key), undefined),
}

/** Prefix of every key that belongs to a signed-in account. */
export const SCOPED_PREFIX = 'chatapp.u'

/** `chatapp.u.<userId>.<authEpoch>.<name>`: one namespace per account and login generation. */
export function scopedKey(userId: string, authEpoch: number, name: string): string {
  return `${SCOPED_PREFIX}.${userId}.${authEpoch}.${name}`
}

/** Removes every account-scoped key (sign-out, lost session). Device-level settings such as appearance stay. */
export function clearScopedStorage(): void {
  for (const key of local.keys()) {
    if (key.startsWith(`${SCOPED_PREFIX}.`)) local.remove(key)
  }
}
