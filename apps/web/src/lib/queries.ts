import {
  type Device,
  devicesResponseSchema,
  type Invite,
  type InviteRegistration,
  inviteRegistrationSchema,
  inviteSchema,
  type Me,
  meSchema,
} from '@chatapp/contracts'
import { type QueryClient, queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { ApiError, api } from './api.ts'
import { mergeMe } from './sync/merge.ts'

export const queryKeys = {
  me: ['me'] as const,
  devices: ['me', 'devices'] as const,
  invites: ['invites'] as const,
  passkeys: ['passkeys'] as const,
}

/** `null` means "not signed in": the probe's 401 is an answer here, not an error. */
async function fetchMe(signal?: AbortSignal): Promise<Me | null> {
  try {
    return await api('/api/me', { schema: meSchema, anonymous: true, signal })
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

/**
 * Every write of the identity goes through the version merge (D-150): a read that was slow, or a write answer that
 * overtook it, can never put an older profile back. `null` (nobody signed in) and a different identity (another
 * account, or the same one after a password change, which has a new login generation) always replace.
 */
export function writeMe(client: QueryClient, incoming: Me | null): void {
  client.setQueryData<Me | null>(queryKeys.me, (current) => mergeMe(current, incoming))
}

/**
 * The answer to a write on my own account (a profile edit, the time zone): it can only update the identity it was made for
 * (D-171). Unlike a fresh read it never replaces one identity with another and never writes into an empty cache, so an
 * answer that comes back after the account changed (a sign-out, another sign-in) is dropped instead of showing the first
 * account's profile to the second.
 */
export function writeMeAnswer(client: QueryClient, answer: Me): void {
  client.setQueryData<Me | null>(queryKeys.me, (current) =>
    current !== null &&
    current !== undefined &&
    current.id === answer.id &&
    current.authEpoch === answer.authEpoch &&
    current.restoreEpoch === answer.restoreEpoch
      ? mergeMe(current, answer)
      : current,
  )
}

export const meQuery = queryOptions({
  queryKey: queryKeys.me,
  queryFn: async ({ client, signal }) =>
    mergeMe(client.getQueryData<Me | null>(queryKeys.me), await fetchMe(signal)),
  staleTime: 60_000,
})

export const devicesQuery = queryOptions({
  queryKey: queryKeys.devices,
  queryFn: async ({ signal }): Promise<Device[]> =>
    (await api('/api/me/devices', { schema: devicesResponseSchema, signal })).devices,
  // A device list that is minutes old can hide a session that was just revoked elsewhere.
  staleTime: 5_000,
})

const invitesResponseSchema = z.object({
  invites: z.array(inviteSchema),
  registrations: z.array(inviteRegistrationSchema),
})

export type InvitesData = { invites: Invite[]; registrations: InviteRegistration[] }

export const invitesQuery = queryOptions({
  queryKey: queryKeys.invites,
  queryFn: ({ signal }): Promise<InvitesData> =>
    api('/api/invites', { schema: invitesResponseSchema, signal }),
  staleTime: 5_000,
})
