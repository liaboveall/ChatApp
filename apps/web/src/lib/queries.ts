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
import { queryOptions } from '@tanstack/react-query'
import { z } from 'zod'
import { ApiError, api } from './api.ts'

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

export const meQuery = queryOptions({
  queryKey: queryKeys.me,
  queryFn: ({ signal }) => fetchMe(signal),
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
