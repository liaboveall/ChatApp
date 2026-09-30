/** Removes the local dev containers AND their volumes (all local data). Requires --yes. */
import { $ } from 'bun'

if (!process.argv.includes('--yes')) {
  console.error(
    'This deletes ALL local dev data (Postgres, Valkey, Garage volumes).\n' +
      'Re-run with: bun run infra:reset --yes',
  )
  process.exit(1)
}

await $`docker compose -f infra/compose.dev.yml --env-file .env.local down -v`
console.log('removed. Next: bun run infra:up && bun run infra:bootstrap')
