import { containsIdentity, isTooSimple, LIMITS, type PasswordContext } from '@chatapp/contracts'
import { Circle, CircleCheck, CircleX } from 'lucide-react'
import { Icon } from '@/components/ui/icon.tsx'
import { cx } from '@/lib/cx.ts'
import { PRODUCT_NAME } from '@/lib/product.ts'
import { m } from '@/paraglide/messages.js'

type RuleState = 'idle' | 'pass' | 'fail'

export type PasswordRuleResult = {
  length: RuleState
  simple: RuleState
  identity: RuleState
  common: RuleState
}

/**
 * Live status of each rule. Length, structure and identity are the same functions the server runs; the common-password
 * list stays on the server, so that rule only turns red when a submission was refused for it (`serverProblem`).
 */
export function evaluatePassword(
  password: string,
  context: PasswordContext,
  serverProblem?: string,
): PasswordRuleResult {
  if (password.length === 0) {
    return { length: 'idle', simple: 'idle', identity: 'idle', common: 'idle' }
  }
  const long = password.length >= LIMITS.passwordMinLength
  return {
    length: long ? 'pass' : 'fail',
    // Structure and identity are only meaningful for a password that is long enough to be a candidate.
    simple: long ? (isTooSimple(password) ? 'fail' : 'pass') : 'idle',
    identity: containsIdentity(password, { ...context, productName: PRODUCT_NAME })
      ? 'fail'
      : 'pass',
    common: serverProblem === 'too_common' ? 'fail' : 'idle',
  }
}

export function passwordAcceptable(result: PasswordRuleResult): boolean {
  return result.length === 'pass' && result.simple === 'pass' && result.identity === 'pass'
}

const ICONS = { idle: Circle, pass: CircleCheck, fail: CircleX } as const
const TONE = {
  idle: 'text-label-secondary',
  pass: 'text-success-text',
  fail: 'text-danger-text',
} as const

function Rule({ state, children }: { state: RuleState; children: string }) {
  const status =
    state === 'idle'
      ? m.password_rule_idle()
      : state === 'pass'
        ? m.password_rule_pass()
        : m.password_rule_fail()
  return (
    <li className={cx('flex items-center gap-1.5 text-subheadline', TONE[state])}>
      <Icon icon={ICONS[state]} size={16} />
      {children}
      <span className="sr-only">{status}</span>
    </li>
  )
}

/** The checklist under a new-password field: icon and text for every rule, never colour alone. */
export function PasswordRules({ result }: { result: PasswordRuleResult }) {
  return (
    <ul aria-label={m.password_rules_label()} className="mt-0.5 grid gap-1">
      <Rule state={result.length}>{m.password_rule_length({ min: LIMITS.passwordMinLength })}</Rule>
      <Rule state={result.simple}>{m.password_rule_simple()}</Rule>
      <Rule state={result.identity}>{m.password_rule_identity()}</Rule>
      <Rule state={result.common}>{m.password_rule_common()}</Rule>
    </ul>
  )
}
