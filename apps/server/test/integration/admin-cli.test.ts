import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { AppError } from '@chatapp/contracts'
import { accounts, auditLogs, users } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import { createAccountFromCli } from '../../src/domain/admin.ts'
import { openTestDatabases, type TestDatabases, truncateAll } from '../support/db.ts'
import { makeDeps } from '../support/deps.ts'

let dbs: TestDatabases
beforeAll(() => {
  dbs = openTestDatabases()
})
afterAll(async () => {
  await truncateAll(dbs.owner)
  await dbs.close()
})
beforeEach(async () => {
  await truncateAll(dbs.owner)
})

const good = {
  email: 'ops@example.com',
  username: 'operator',
  displayName: 'Operator',
  password: 'violet-harbor-91-compass',
  role: 'admin' as const,
  actor: 'cli',
}

async function refusal(input: typeof good): Promise<AppError | Error | undefined> {
  try {
    await createAccountFromCli(makeDeps(dbs.owner.db), input)
    return undefined
  } catch (error) {
    return error as Error
  }
}

describe('createAccountFromCli', () => {
  test('creates an active, verified administrator and audits it', async () => {
    const created = await createAccountFromCli(makeDeps(dbs.owner.db), {
      ...good,
      email: 'Ops@Example.com',
      displayName: '  Operator  ',
    })
    const [user] = await dbs.owner.db.select().from(users).where(eq(users.id, created.id))
    expect(user).toMatchObject({
      email: 'ops@example.com',
      username: 'operator',
      name: 'Operator',
      role: 'admin',
      accountSource: 'cli',
      activationStatus: 'active',
      emailVerified: true,
    })
    expect(
      await dbs.owner.db.select().from(accounts).where(eq(accounts.userId, created.id)),
    ).toHaveLength(1)
    const audits = await dbs.owner.db.select().from(auditLogs)
    expect(audits.map((row) => row.action)).toEqual(['admin.account_created'])
  })

  test('an upper-case username is refused with the field and the rule, and nothing is stored', async () => {
    const error = await refusal({ ...good, username: 'God' })
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('VALIDATION_FAILED')
    expect((error as AppError).details).toEqual({
      field: 'username',
      reason: 'Only lower-case letters, digits and underscores',
    })
    expect(await dbs.owner.db.select().from(users)).toHaveLength(0)
  })

  test('other bad fields and reserved names name their field too', async () => {
    expect(((await refusal({ ...good, email: 'nope' })) as AppError).details?.field).toBe('email')
    expect(((await refusal({ ...good, displayName: '  ' })) as AppError).details?.field).toBe(
      'name',
    )
    expect(((await refusal({ ...good, username: 'admin' })) as AppError).details).toEqual({
      field: 'username',
      reason: 'this name is reserved',
    })
    expect(await dbs.owner.db.select().from(users)).toHaveLength(0)
  })

  test('a refused password names the rule and never echoes the password', async () => {
    // Built at run time: it is the username plus a suffix, which the policy must recognise as built from the username.
    const guess = `${good.username}-2026-xyz`
    const weak = await refusal({ ...good, password: guess })
    expect((weak as AppError).details).toEqual({ field: 'password', reason: 'contains_identity' })
    expect(JSON.stringify((weak as AppError).details)).not.toContain('2026')
    const short = await refusal({ ...good, password: 'short1' })
    expect((short as AppError).details).toEqual({ field: 'password', reason: 'too_short' })
    expect(await dbs.owner.db.select().from(users)).toHaveLength(0)
  })

  test('a taken email or username is a conflict', async () => {
    await createAccountFromCli(makeDeps(dbs.owner.db), good)
    const sameEmail = await refusal({ ...good, username: 'second_one' })
    const sameName = await refusal({ ...good, email: 'other@example.com' })
    for (const error of [sameEmail, sameName]) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('CONFLICT')
    }
    expect(await dbs.owner.db.select().from(users)).toHaveLength(1)
  })
})
