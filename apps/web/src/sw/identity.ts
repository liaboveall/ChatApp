/**
 * What the worker remembers about the account signed in on this browser (D-070, SEC-34): who it is and which browser
 * installation this is, nothing else. The page writes it when somebody signs in or turns push on; a sign-out, here or in
 * another tab, removes it. A push for anybody else is not shown.
 */
import { createStore, del, get, set } from 'idb-keyval'

export type Identity = { userId: string; installationId: string }

const store = createStore('chatapp-sw', 'identity')
const KEY = 'current'

export async function readIdentity(): Promise<Identity | undefined> {
  try {
    const value = await get<Identity>(KEY, store)
    return value && typeof value.userId === 'string' && typeof value.installationId === 'string'
      ? value
      : undefined
  } catch {
    return undefined
  }
}

export async function writeIdentity(identity: Identity): Promise<void> {
  await set(KEY, identity, store)
}

export async function clearIdentity(): Promise<void> {
  try {
    await del(KEY, store)
  } catch {
    // Nothing stored, or storage is not available: there is nothing left to forget.
  }
}
