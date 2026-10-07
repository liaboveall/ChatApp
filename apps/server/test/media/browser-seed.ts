import { accounts, users } from '@chatapp/db'
import { createDatabase } from '@chatapp/db/client'
import { sdkPasswords } from '../../src/auth/passwords.ts'
import { loadConfig } from '../../src/config/env.ts'
export async function seedBrowser() {
  const database = createDatabase(loadConfig(process.env).databaseUrl)
  try {
    const people = []
    for (const name of ['alice', 'bobby', 'charlie', 'david']) {
      const password = `M3-browser-${crypto.randomUUID()}`
      const [user] = await database.db
        .insert(users)
        .values({
          name,
          username: `m3_${name}`,
          email: `${name}@example.test`,
          emailVerified: true,
          activationStatus: 'active',
          accountSource: 'cli',
        })
        .returning()
      if (!user) throw new Error('browser seed failed')
      await database.db.insert(accounts).values({
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password: await sdkPasswords.hash(password),
      })
      people.push({
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        password,
      })
    }
    console.log(JSON.stringify(people))
  } finally {
    await database.close()
  }
}
