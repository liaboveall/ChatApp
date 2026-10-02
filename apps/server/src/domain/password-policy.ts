/**
 * Password policy beyond length (SEC-10): reject entries of the common-password list, trivially structured values and
 * passwords built from the account's own identifiers. Checked on registration, reset and change; login never applies it.
 */
import { LIMITS } from '@chatapp/contracts'
import { COMMON_PASSWORDS } from './common-passwords.ts'

export type PasswordProblem =
  | 'too_short'
  | 'too_long'
  | 'too_common'
  | 'too_simple'
  | 'contains_identity'

export type PasswordContext = {
  email?: string
  username?: string
  displayName?: string
  productName?: string
}

const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  '9876543210',
  'zyxwvutsrqponmlkjihgfedcba',
  'qwertyuiopasdfghjklzxcvbnm',
  '1qaz2wsx3edc4rfv5tgb6yhn7ujm',
]

/** Longest run of characters that follow each other in a known sequence, or repeat the same character. */
function longestPattern(value: string): number {
  let best = 1
  let repeat = 1
  for (let i = 1; i < value.length; i += 1) {
    repeat = value[i] === value[i - 1] ? repeat + 1 : 1
    best = Math.max(best, repeat)
  }
  for (const sequence of SEQUENCES) {
    let run = 1
    for (let i = 1; i < value.length; i += 1) {
      const at = sequence.indexOf(value[i - 1] ?? '')
      run = at >= 0 && sequence[at + 1] === value[i] ? run + 1 : 1
      best = Math.max(best, run)
    }
  }
  return best
}

export function checkPassword(
  password: string,
  context: PasswordContext = {},
): PasswordProblem | null {
  if (password.length < LIMITS.passwordMinLength) return 'too_short'
  if (password.length > LIMITS.passwordMaxLength) return 'too_long'
  const lower = password.toLowerCase()
  if (COMMON_PASSWORDS.has(lower)) return 'too_common'
  // Too few distinct characters, or a long pattern (aaaaaaaaaa, 12345678ab) is not a secret.
  if (new Set(lower).size < 5) return 'too_simple'
  if (longestPattern(lower) >= Math.ceil(lower.length * 0.7)) return 'too_simple'

  const local = context.email?.split('@')[0]?.toLowerCase()
  const identities = [local, context.username, context.displayName, context.productName]
    .map((value) => value?.toLowerCase().replace(/\s+/g, ''))
    .filter((value): value is string => value !== undefined && value.length >= 4)
  if (identities.some((identity) => lower.includes(identity))) return 'contains_identity'
  return null
}
