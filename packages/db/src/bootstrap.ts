/**
 * Production-safe, idempotent base data (docs/04 section 9): system-reserved usernames, the non-login Agent account
 * and a bootstrap marker. It never creates demo users or credentials; `db:seed` (development only) builds on it.
 */
import { RESERVED_USERNAMES } from '@chatapp/contracts'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from './client.ts'
import { appSettings, auditLogs, usernameReservations, users } from './schema/index.ts'

/** Bump when a later release needs bootstrap to run again; the application checks it at startup. */
export const BOOTSTRAP_VERSION = 1

/** Arbitrary constant: "boot" as a number, serializes concurrent bootstraps. */
const BOOTSTRAP_LOCK_KEY = 0x626f6f74

export type BootstrapOptions = {
  agentUsername: string
  agentDisplayName: string
  productName: string
}

export type BootstrapResult = {
  agentUserId: string
  agentCreated: boolean
  reservedUsernames: number
}

export async function runBootstrap(db: Db, options: BootstrapOptions): Promise<BootstrapResult> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`)

    const reserved = new Set(RESERVED_USERNAMES)
    reserved.add(options.agentUsername)
    const product = options.productName.toLowerCase().replace(/[^a-z0-9_]/g, '')
    if (product.length >= 3 && product.length <= 20) reserved.add(product)
    await tx
      .insert(usernameReservations)
      .values([...reserved].map((username) => ({ username, userId: null, reservedUntil: null })))
      .onConflictDoNothing()

    const existing = await tx
      .select({ id: users.id, name: users.name, isBot: users.isBot })
      .from(users)
      .where(eq(users.username, options.agentUsername))
      .limit(1)
    const found = existing[0]
    if (found && !found.isBot) {
      throw new Error(
        `username "${options.agentUsername}" belongs to a human account; change AGENT_USERNAME or rename that account`,
      )
    }

    let agentUserId = found?.id
    let agentCreated = false
    if (found === undefined) {
      const [created] = await tx
        .insert(users)
        .values({
          name: options.agentDisplayName,
          // `.invalid` is reserved by RFC 2606 and can never receive mail.
          email: `${options.agentUsername}@bot.invalid`,
          emailVerified: true,
          username: options.agentUsername,
          activationStatus: 'active',
          accountSource: 'bootstrap',
          isBot: true,
          inviteQuota: 0,
        })
        .returning({ id: users.id })
      agentUserId = created?.id
      agentCreated = true
      await tx.insert(auditLogs).values({
        action: 'bootstrap.agent_created',
        targetType: 'user',
        targetId: agentUserId,
      })
    } else if (found.name !== options.agentDisplayName) {
      await tx
        .update(users)
        .set({
          name: options.agentDisplayName,
          profileVersion: sql`${users.profileVersion} + 1`,
          meVersion: sql`${users.meVersion} + 1`,
        })
        .where(and(eq(users.id, found.id), eq(users.isBot, true)))
    }
    if (agentUserId === undefined) throw new Error('agent account was not created')

    await tx
      .insert(appSettings)
      .values({ key: 'bootstrap', value: { version: BOOTSTRAP_VERSION, agentUserId } })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value: { version: BOOTSTRAP_VERSION, agentUserId },
          version: sql`${appSettings.version} + 1`,
        },
      })

    return { agentUserId, agentCreated, reservedUsernames: reserved.size }
  })
}

/** True when bootstrap has run for the current BOOTSTRAP_VERSION; the application refuses to start otherwise. */
export async function isBootstrapped(db: Db): Promise<boolean> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, 'bootstrap'))
    .limit(1)
  const value = rows[0]?.value as { version?: unknown } | undefined
  return typeof value?.version === 'number' && value.version >= BOOTSTRAP_VERSION
}
