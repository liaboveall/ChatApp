/**
 * Operator commands (docs/03 section 3, docs/04 section 9):
 *   bun apps/server/src/cli.ts migrate        apply migrations as the owner, create/grant the application role
 *   bun apps/server/src/cli.ts db:bootstrap   idempotent production-safe base data
 *   bun apps/server/src/cli.ts db:seed        development only: bootstrap plus three demo members
 *   bun apps/server/src/cli.ts admin:create --email E --username U --name N   the password is typed at a prompt
 *   bun apps/server/src/cli.ts admin:verify-email --email E                    mark an email as verified (audited)
 * Secrets are never printed. Run through the root scripts, which load .env.local.
 */
import { AppError, LIMITS } from '@chatapp/contracts'
import { runBootstrap } from '@chatapp/db/bootstrap'
import { createDatabase } from '@chatapp/db/client'
import { runMigrations } from '@chatapp/db/migrate'
import { sdkPasswords } from './auth/passwords.ts'
import { readSecret } from './cli/secret-prompt.ts'
import { type Config, ConfigError, loadConfig } from './config/index.ts'
import {
  type CheckedIdentity,
  checkAccountFields,
  checkAccountPassword,
  createAccountFromCli,
} from './domain/admin.ts'
import { verifyEmailManually } from './domain/credentials.ts'
import type { Deps } from './domain/deps.ts'
import type { PasswordProblem } from './domain/password-policy.ts'
import { systemClock } from './lib/clock.ts'
import { silentLogger } from './lib/logger.ts'
import { uuidv7 } from './runtime/ids.ts'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function ownerUrl(config: Config): string {
  if (!config.databaseOwnerUrl) {
    fail(`DATABASE_OWNER_URL${config.env === 'test' ? '_TEST' : ''} is required for this command`)
  }
  return config.databaseOwnerUrl
}

async function migrate(config: Config): Promise<void> {
  const owner = new URL(ownerUrl(config))
  const app = new URL(config.databaseUrl)
  const appRole =
    app.username !== owner.username
      ? { role: decodeURIComponent(app.username), password: decodeURIComponent(app.password) }
      : undefined
  await runMigrations({ ownerUrl: ownerUrl(config), appRole })
  console.log(
    appRole
      ? `migrations applied to ${owner.pathname.slice(1)}; application role "${appRole.role}" ready`
      : `migrations applied to ${owner.pathname.slice(1)}; DATABASE_URL uses the owner account (no separate application role)`,
  )
}

async function bootstrap(config: Config): Promise<void> {
  const { db, close } = createDatabase(ownerUrl(config), { max: 2, applicationName: 'chatapp-cli' })
  try {
    const result = await runBootstrap(db, {
      agentUsername: config.product.agentUsername,
      agentDisplayName: config.product.agentDisplayName,
      productName: config.product.name,
    })
    console.log(
      `bootstrap ok: agent account ${result.agentCreated ? 'created' : 'present'}, ${result.reservedUsernames} reserved usernames`,
    )
  } finally {
    await close()
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function requireOption(name: string): string {
  return option(name) ?? fail(`missing --${name}`)
}

function cliDeps(config: Config, db: Deps['db']): Deps {
  return {
    db,
    clock: systemClock,
    newId: uuidv7,
    config: {
      origin: config.origin,
      timezone: config.timezone,
      auth: {
        tokenEncryptionKey: config.auth.tokenEncryptionKey,
        restoreEpoch: config.auth.restoreEpoch,
      },
      product: config.product,
    },
    passwords: sdkPasswords,
    log: silentLogger,
  }
}

const FIELD_RULES = {
  email: 'a valid email address',
  username: `${LIMITS.usernameMinLength} to ${LIMITS.usernameMaxLength} characters; lower-case letters, digits and underscores only`,
  name: `1 to ${LIMITS.displayNameMaxGraphemes} characters, no control or invisible characters`,
} as const

/** Why a password was refused. Says what rule it broke, never what was typed. */
const PASSWORD_ADVICE: Record<PasswordProblem, string> = {
  too_short: `use at least ${LIMITS.passwordMinLength} characters`,
  too_long: `use at most ${LIMITS.passwordMaxLength} characters`,
  too_common: 'it is on the list of common passwords',
  too_simple: 'it is too simple (repeated or sequential characters, or too few different ones)',
  contains_identity: 'it contains your email name, username, display name or the product name',
}

/** Asks until the password is acceptable: three tries at a terminal, one for a piped password. */
async function promptNewPassword(config: Config, identity: CheckedIdentity): Promise<string> {
  const tries = process.stdin.isTTY ? 3 : 1
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const password = await readSecret('Password: ')
    const problem = checkAccountPassword(config.product, identity, password)
    if (problem !== null) {
      console.error(`password not accepted: ${PASSWORD_ADVICE[problem]}`)
    } else if (!process.stdin.isTTY || password === (await readSecret('Repeat password: '))) {
      return password
    } else {
      console.error('passwords do not match')
    }
  }
  return fail('no acceptable password was entered')
}

async function adminCreate(config: Config): Promise<void> {
  // The fields are checked with the registration rules before any password is asked for.
  const checked = checkAccountFields(config.product, {
    email: requireOption('email'),
    username: requireOption('username'),
    displayName: requireOption('name'),
  })
  if (!checked.ok) {
    const { field, reason } = checked.problem
    fail(`--${field}: ${reason}\n  rule: ${FIELD_RULES[field]}`)
  }
  const identity = checked.value
  const password = await promptNewPassword(config, identity)
  const { db, close } = createDatabase(ownerUrl(config), { max: 2, applicationName: 'chatapp-cli' })
  try {
    const created = await createAccountFromCli(cliDeps(config, db), {
      ...identity,
      password,
      role: 'admin',
      actor: 'cli',
    })
    console.log(`administrator "${identity.username}" created (${created.id})`)
  } finally {
    await close()
  }
}

async function adminVerifyEmail(config: Config): Promise<void> {
  const email = requireOption('email')
  const { db, close } = createDatabase(ownerUrl(config), { max: 2, applicationName: 'chatapp-cli' })
  try {
    const changed = await verifyEmailManually(cliDeps(config, db), { email, actor: 'cli' })
    console.log(
      changed ? 'email marked as verified' : 'nothing to do (unknown address or already verified)',
    )
  } finally {
    await close()
  }
}

/** Development only: three demo members whose password is SEED_DEMO_PASSWORD. Existing ones are left alone. */
async function seed(config: Config): Promise<void> {
  if (config.env === 'production') fail('db:seed is for development only')
  const password = process.env.SEED_DEMO_PASSWORD
  if (!password) fail('SEED_DEMO_PASSWORD is not set (run `bun run setup`)')
  await bootstrap(config)
  const { db, close } = createDatabase(ownerUrl(config), { max: 2, applicationName: 'chatapp-cli' })
  try {
    const deps = cliDeps(config, db)
    let created = 0
    for (const name of ['alice', 'bob', 'carol']) {
      try {
        await createAccountFromCli(deps, {
          email: `${name}@example.test`,
          username: name,
          displayName: name[0]?.toUpperCase() + name.slice(1),
          password,
          role: 'user',
          actor: 'seed',
        })
        created += 1
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'CONFLICT') throw error
      }
    }
    console.log(`seed ok: ${created} demo members created, ${3 - created} already present`)
  } finally {
    await close()
  }
}

const COMMANDS: Record<string, (config: Config) => Promise<void>> = {
  migrate,
  'db:bootstrap': bootstrap,
  'db:seed': seed,
  'admin:create': adminCreate,
  'admin:verify-email': adminVerifyEmail,
}

const command = process.argv[2]
const run = command === undefined ? undefined : COMMANDS[command]
if (run === undefined) {
  fail(`usage: cli.ts <${Object.keys(COMMANDS).join('|')}>`)
}

try {
  await run(loadConfig(process.env))
} catch (error) {
  if (error instanceof ConfigError) fail(error.message)
  // Our own errors carry text we wrote plus the offending field and rule; database errors can quote submitted values.
  if (error instanceof AppError) {
    const { field, reason } = error.details ?? {}
    const where =
      typeof field === 'string'
        ? ` (${field}${typeof reason === 'string' ? `: ${reason}` : ''})`
        : ''
    fail(`${command} failed: ${error.message}${where}`)
  }
  // Database errors can quote submitted values; show only the class name and a short code.
  const name = error instanceof Error ? error.name : 'Error'
  const code = (error as { code?: unknown }).code
  fail(`${command} failed: ${name}${typeof code === 'string' ? ` (${code})` : ''}`)
}
