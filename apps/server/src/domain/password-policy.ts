/**
 * Password policy beyond length (SEC-10): the structural rules live in packages/contracts so the web forms show the same
 * hints; the common-password list stays here and is passed in. Checked on registration, reset and change; login never
 * applies it.
 */
import {
  checkPassword as checkStructure,
  type PasswordContext,
  type PasswordProblem,
} from '@chatapp/contracts'
import { COMMON_PASSWORDS } from './common-passwords.ts'

export type { PasswordContext, PasswordProblem }

export function checkPassword(
  password: string,
  context: PasswordContext = {},
): PasswordProblem | null {
  return checkStructure(password, context, (lower) => COMMON_PASSWORDS.has(lower))
}
