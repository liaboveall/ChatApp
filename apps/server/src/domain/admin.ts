/**
 * Accounts created by an operator at the terminal (docs/04 section 9, INV-18's audited exception). They go through the
 * same name, password and uniqueness rules as members, never through an HTTP admin backdoor, and leave an audit row.
 */
import {
  AppError,
  isReservedDisplayName,
  isReservedUsername,
  normalizeEmail,
  signUpRequestSchema,
  type UserRole,
} from '@chatapp/contracts'
import { accounts, users } from '@chatapp/db'
import { isUniqueViolation } from '../lib/pg-error.ts'
import { writeAudit } from './audit.ts'
import type { Deps } from './deps.ts'
import { checkPassword, type PasswordProblem } from './password-policy.ts'
import { inTransaction } from './tx.ts'

export type CliAccountInput = {
  email: string
  username: string
  displayName: string
  password: string
  role: UserRole
  /** Who ran the command, for the audit trail (never a secret). */
  actor: string
}

/** The identity fields an operator types; they follow the registration body, so the rules cannot drift apart. */
const identityFields = signUpRequestSchema.pick({ email: true, username: true, name: true })

/** `field` is the name of the command line option and of the registration body field. */
export type AccountFieldProblem = { field: 'email' | 'username' | 'name'; reason: string }
export type CheckedIdentity = { email: string; username: string; displayName: string }

/**
 * Applies the registration rules to what an operator typed: the contract schemas first, then the reserved names. The
 * result carries the normalized values to store; a problem names the field and the rule, never the value.
 */
export function checkAccountFields(
  product: Deps['config']['product'],
  input: { email: string; username: string; displayName: string },
): { ok: true; value: CheckedIdentity } | { ok: false; problem: AccountFieldProblem } {
  const parsed = identityFields.safeParse({
    email: input.email,
    username: input.username,
    name: input.displayName,
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field =
      issue?.path[0] === 'email' || issue?.path[0] === 'name' ? issue.path[0] : 'username'
    return { ok: false, problem: { field, reason: issue?.message ?? 'not acceptable' } }
  }
  const { email, username, name } = parsed.data
  if (isReservedUsername(username, [product.agentUsername, product.name])) {
    return { ok: false, problem: { field: 'username', reason: 'this name is reserved' } }
  }
  if (isReservedDisplayName(name, [product.agentDisplayName])) {
    return { ok: false, problem: { field: 'name', reason: 'this name is reserved' } }
  }
  return { ok: true, value: { email: normalizeEmail(email), username, displayName: name } }
}

/** The password policy with the account's own identifiers as context (it must not be built from them). */
export function checkAccountPassword(
  product: Deps['config']['product'],
  identity: CheckedIdentity,
  password: string,
): PasswordProblem | null {
  return checkPassword(password, {
    email: identity.email,
    username: identity.username,
    displayName: identity.displayName,
    productName: product.name,
  })
}

export async function createAccountFromCli(
  deps: Deps,
  input: CliAccountInput,
): Promise<{ id: string }> {
  const checked = checkAccountFields(deps.config.product, input)
  if (!checked.ok) {
    throw new AppError('VALIDATION_FAILED', 'Account details are not acceptable', {
      details: { ...checked.problem },
    })
  }
  const identity = checked.value
  const problem = checkAccountPassword(deps.config.product, identity, input.password)
  if (problem !== null) {
    throw new AppError('VALIDATION_FAILED', 'Password is not acceptable', {
      details: { field: 'password', reason: problem },
    })
  }
  const passwordHash = await deps.passwords.hash(input.password)
  try {
    return await inTransaction(deps.db, async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          name: identity.displayName,
          email: identity.email,
          username: identity.username,
          role: input.role,
          accountSource: 'cli',
          activationStatus: 'active',
          emailVerified: true,
        })
        .returning({ id: users.id })
      if (!user) throw new Error('account was not created')
      await tx.insert(accounts).values({
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password: passwordHash,
      })
      await writeAudit(tx, {
        action: 'admin.account_created',
        targetType: 'user',
        targetId: user.id,
        metadata: { role: input.role, by: input.actor },
      })
      return user
    })
  } catch (error) {
    if (
      isUniqueViolation(error, 'users_email_unique') ||
      isUniqueViolation(error, 'users_username_unique')
    ) {
      throw new AppError('CONFLICT', 'Email or username already exists')
    }
    throw error
  }
}
