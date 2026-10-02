/**
 * The only way to declare a jsonb column (guard rule, docs/12 D-107).
 *
 * Drizzle's own `jsonb()` stringifies the value and Bun's driver then encodes that string a second time, so every value
 * lands in Postgres as a jsonb *string* holding JSON text: ->>, @> and indexes see nothing. Sending the JSON as text and
 * casting it in SQL stores the real value. Reading needs no conversion: Bun returns parsed JSON for jsonb.
 */
import { sql } from 'drizzle-orm'
import { customType } from 'drizzle-orm/pg-core'

export const jsonbValue = <T>() =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => 'jsonb',
    toDriver: (value) => sql`${JSON.stringify(value)}::text::jsonb`,
    fromDriver: (value) => value as T,
  })()
