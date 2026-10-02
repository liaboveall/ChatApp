/** Calls of the authentication pages (docs/05 section 3.1). All of them are open to anonymous callers except sign-out. */
import {
  type AcceptedResponse,
  acceptedResponseSchema,
  type ChangePasswordRequest,
  INVITE_CODE_HEADER,
  inviteCheckResponseSchema,
  okResponseSchema,
  type PasswordResetConsume,
  type SignInRequest,
  type SignUpRequest,
  signUpResponseSchema,
} from '@chatapp/contracts'
import { api } from '@/lib/api.ts'

export const authApi = {
  signIn: (body: SignInRequest) =>
    api('/api/auth/sign-in/email', { json: body, schema: okResponseSchema, anonymous: true }),

  signUp: (body: SignUpRequest, inviteCode: string, idempotencyKey: string) =>
    api('/api/auth/sign-up/email', {
      json: body,
      headers: { [INVITE_CODE_HEADER]: inviteCode },
      idempotencyKey,
      schema: signUpResponseSchema,
      anonymous: true,
    }),

  checkInvite: (code: string) =>
    api('/api/invites/check', {
      json: { code },
      schema: inviteCheckResponseSchema,
      anonymous: true,
    }),

  requestVerification: (email: string): Promise<AcceptedResponse> =>
    api('/api/auth/verification/request', {
      json: { email },
      schema: acceptedResponseSchema,
      anonymous: true,
    }),

  consumeVerification: (token: string) =>
    api('/api/auth/verification/consume', {
      json: { token },
      schema: okResponseSchema,
      anonymous: true,
    }),

  requestPasswordReset: (email: string): Promise<AcceptedResponse> =>
    api('/api/auth/password/request-reset', {
      json: { email },
      schema: acceptedResponseSchema,
      anonymous: true,
    }),

  consumePasswordReset: (body: PasswordResetConsume) =>
    api('/api/auth/password/consume-reset', {
      json: body,
      schema: okResponseSchema,
      anonymous: true,
    }),

  changePassword: (body: ChangePasswordRequest) =>
    api('/api/auth/change-password', { json: body, schema: okResponseSchema }),

  signOut: () =>
    api('/api/auth/sign-out', { method: 'POST', schema: okResponseSchema, anonymous: true }),
}

export type AuthApi = typeof authApi
