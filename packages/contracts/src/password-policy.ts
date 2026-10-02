/**
 * Password policy beyond length (SEC-10), shared by the server (authoritative) and the web forms (live hints).
 * Everything except the common-password list is pure and lives here; the list itself stays on the server, which passes
 * it in as `isCommon`. Checked on registration, reset and change; login never applies it.
 */
import { LIMITS } from './limits.ts'

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

/** Too few distinct characters, or a long pattern (aaaaaaaaaa, 12345678ab) is not a secret. */
export function isTooSimple(password: string): boolean {
  const lower = password.toLowerCase()
  if (new Set(lower).size < 5) return true
  return longestPattern(lower) >= Math.ceil(lower.length * 0.7)
}

/** Does the password contain the account's own identifiers (4 or more characters each)? */
export function containsIdentity(password: string, context: PasswordContext): boolean {
  const lower = password.toLowerCase()
  const local = context.email?.split('@')[0]?.toLowerCase()
  const identities = [local, context.username, context.displayName, context.productName]
    .map((value) => value?.toLowerCase().replace(/\s+/g, ''))
    .filter((value): value is string => value !== undefined && value.length >= 4)
  return identities.some((identity) => lower.includes(identity))
}

/**
 * The first problem found, in this order: length, common list, too simple, identity. `isCommon` receives the lower-cased
 * password; without it the list check is skipped (the web forms cannot see the list).
 */
export function checkPassword(
  password: string,
  context: PasswordContext = {},
  isCommon: (lower: string) => boolean = () => false,
): PasswordProblem | null {
  if (password.length < LIMITS.passwordMinLength) return 'too_short'
  if (password.length > LIMITS.passwordMaxLength) return 'too_long'
  if (isCommon(password.toLowerCase())) return 'too_common'
  if (isTooSimple(password)) return 'too_simple'
  if (containsIdentity(password, context)) return 'contains_identity'
  return null
}
