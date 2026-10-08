/** Request/response bodies of the controlled authentication endpoints (docs/05 section 3.1). */
import { z } from 'zod'
import {
  authTokenSchema,
  displayNameSchema,
  emailSchema,
  passwordSchema,
  usernameSchema,
} from './identity.ts'

/** Header carrying the invite code, never the URL or the query (D-045). */
export const INVITE_CODE_HEADER = 'x-invite-code'
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'

export const signUpRequestSchema = z.strictObject({
  email: emailSchema,
  username: usernameSchema,
  name: displayNameSchema,
  password: passwordSchema,
})
export type SignUpRequest = z.infer<typeof signUpRequestSchema>

/** Generic on purpose: an existing email gets the same answer as a new one. */
export const signUpResponseSchema = z.object({ status: z.literal('verification_required') })
export type SignUpResponse = z.infer<typeof signUpResponseSchema>

export const signInRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(256),
  rememberMe: z.boolean().optional(),
})
export type SignInRequest = z.infer<typeof signInRequestSchema>

/** Sign-in failures keep the SDK's flat shape (docs/05 section 1): login clients already understand it. */
export const signInErrorSchema = z.object({
  code: z.enum(['INVALID_EMAIL_OR_PASSWORD', 'EMAIL_NOT_VERIFIED', 'ACCOUNT_NOT_ACTIVE']),
  message: z.string(),
})
export type SignInError = z.infer<typeof signInErrorSchema>

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
})
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>

export const verificationRequestSchema = z.strictObject({ email: emailSchema })
export type VerificationRequest = z.infer<typeof verificationRequestSchema>

export const verificationConsumeSchema = z.strictObject({ token: authTokenSchema })
export type VerificationConsume = z.infer<typeof verificationConsumeSchema>

export const passwordResetRequestSchema = z.strictObject({ email: emailSchema })
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>

export const passwordResetConsumeSchema = z.strictObject({
  token: authTokenSchema,
  newPassword: passwordSchema,
})
export type PasswordResetConsume = z.infer<typeof passwordResetConsumeSchema>

/** Anonymous "request" endpoints always answer the same way, whether or not the account exists. */
export const acceptedResponseSchema = z.object({ status: z.literal('accepted') })
export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>

export const okResponseSchema = z.object({ status: z.literal('ok') })
export type OkResponse = z.infer<typeof okResponseSchema>

// ───────── Passkey ceremonies (forwarded to the SDK after strict validation) ─────────

const passkeyName = z.string().trim().min(1).max(64)

/** The WebAuthn credential JSON travels in `response`; its inner shape is verified by the SDK's WebAuthn library. */
export const passkeyVerifyRegistrationSchema = z.strictObject({
  response: z.record(z.string(), z.unknown()),
  name: passkeyName.optional(),
})
export const passkeyVerifyAuthenticationSchema = z.strictObject({
  response: z.record(z.string(), z.unknown()),
})
export const passkeyUpdateSchema = z.strictObject({ id: z.uuid(), name: passkeyName })
export const passkeyDeleteSchema = z.strictObject({ id: z.uuid() })
export const passkeyRegisterOptionsQuerySchema = z.strictObject({
  name: passkeyName.optional(),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
})

// ───────── Devices (docs/03 section 5.9) ─────────

export const deviceSchema = z.object({
  id: z.uuid(),
  current: z.boolean(),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** Reminders and scheduled messages this device authorized that have not run yet (M5a): revoking it cancels them. */
  pendingTasks: z.number().int().nonnegative(),
})
export type Device = z.infer<typeof deviceSchema>

export const devicesResponseSchema = z.object({ devices: z.array(deviceSchema) })
