/** The implementation lives with the server's database and native-model dependencies. */
import { getEnv, readEnvFile } from './lib/env-file.ts'

const command = process.argv.slice(2).filter((arg) => arg !== '--')[0],
  env = await readEnvFile('.env.local')
for (const line of env.lines) {
  const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
  if (
    key &&
    process.env[key] === undefined &&
    (command !== 'prepare' || key === 'EMBEDDING_CACHE_DIR')
  )
    process.env[key] = getEnv(env, key)
}
await import('../apps/server/src/runtime/embedding-command.ts')
