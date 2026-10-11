/**
 * What the worker remembers about the account signed in on this browser (D-070, SEC-34): who it is and which browser
 * installation this is, and a token for this handover. The page writes it when somebody signs in or turns push on; a sign-out, here or in
 * another tab, removes it. A push for anybody else is not shown.
 */
import { createStore, del, get, set } from 'idb-keyval'

export type Identity = { userId: string; installationId: string; handoverId?: string }

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
  // Account and installation can be identical after a sign-out and a new login. Each handover still invalidates work that
  // began before it. Older stored identities without a token remain readable until the next handover replaces them.
  await set(KEY, { ...identity, handoverId: crypto.randomUUID() }, store)
}

export async function clearIdentity(): Promise<void> {
  try {
    await del(KEY, store)
  } catch {
    // Nothing stored, or storage is not available: there is nothing left to forget.
  }
}
