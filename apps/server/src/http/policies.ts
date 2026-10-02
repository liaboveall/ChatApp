/** Rate-limit policies (SEC-11, SEC-16). Anonymous endpoints are limited per IP group and, where an account is named, per account digest. */
import type { LimitPolicy } from '../lib/rate-limit.ts'

const minutes = (n: number) => n * 60_000

export const POLICIES = {
  loginIp: { name: 'login.ip', limit: 20, windowMs: minutes(10) },
  loginAccount: { name: 'login.account', limit: 8, windowMs: minutes(10) },
  registerIp: { name: 'register.ip', limit: 10, windowMs: minutes(60) },
  inviteCheckIp: { name: 'invite-check.ip', limit: 30, windowMs: minutes(10) },
  verificationRequestIp: { name: 'verify-request.ip', limit: 10, windowMs: minutes(60) },
  verificationRequestAccount: { name: 'verify-request.account', limit: 3, windowMs: minutes(60) },
  verificationConsumeIp: { name: 'verify-consume.ip', limit: 30, windowMs: minutes(60) },
  resetRequestIp: { name: 'reset-request.ip', limit: 10, windowMs: minutes(60) },
  resetRequestAccount: { name: 'reset-request.account', limit: 3, windowMs: minutes(60) },
  resetConsumeIp: { name: 'reset-consume.ip', limit: 30, windowMs: minutes(60) },
  changePasswordUser: { name: 'change-password.user', limit: 10, windowMs: minutes(60) },
  wsConnectIp: { name: 'ws-connect.ip', limit: 120, windowMs: minutes(10) },
  passkeyIp: { name: 'passkey.ip', limit: 60, windowMs: minutes(10) },
  apiUser: { name: 'api.user', limit: 600, windowMs: minutes(1) },
} as const satisfies Record<string, LimitPolicy>
