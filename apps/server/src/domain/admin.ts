/**
 * Accounts created by an operator at the terminal (docs/04 section 9, INV-18's audited exception). They go through the
 * same name, password and uniqueness rules as members, never through an HTTP admin backdoor, and leave an audit row.
 */
import {
  AppError,
  isReservedDisplayName,
  isReservedUsername,
  normalizeEmail,
  type UserRole,
} from '@chatapp/contracts'
import { accounts, users } from '@chatapp/db'
import { isUniqueViolation } from '../lib/pg-error.ts'
import { writeAudit } from './audit.ts'
import type { Deps } from './deps.ts'
import { checkPassword } from './password-policy.ts'
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

export async function createAccountFromCli(
  deps: Deps,
  input: CliAccountInput,
): Promise<{ id: string }> {
  const email = normalizeEmail(input.email)
  const extra = [deps.config.product.agentUsername, deps.config.product.name]
  if (
    isReservedUsername(input.username, extra) ||
    isReservedDisplayName(input.displayName, [deps.config.product.agentDisplayName])
  ) {
    throw new AppError('VALIDATION_FAILED', 'Username or display name is reserved')
  }
  const problem = checkPassword(input.password, {
    email,
    username: input.username,
    displayName: input.displayName,
    productName: deps.config.product.name,
  })
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
          name: input.displayName,
          email,
          username: input.username,
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
