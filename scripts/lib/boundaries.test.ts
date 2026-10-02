import { describe, expect, test } from 'bun:test'
import { checkFile } from './boundaries.ts'

describe('Bun-specific API boundary (D-090)', () => {
  test('is rejected in domain code', () => {
    const problems = checkFile('apps/server/src/domain/users.ts', 'const id = Bun.randomUUIDv7()\n')
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('Bun-specific')
  })

  test('is rejected via bun and hono/bun imports', () => {
    expect(checkFile('apps/server/src/http/me.ts', "import { sql } from 'bun'\n")).toHaveLength(1)
    expect(
      checkFile('apps/server/src/http/me.ts', "import { upgradeWebSocket } from 'hono/bun'\n"),
    ).toHaveLength(1)
  })

  test('is allowed in listed adapters, entry points and tests', () => {
    for (const path of [
      'packages/db/src/client.ts',
      'apps/server/src/runtime/ids.ts',
      'apps/server/src/realtime/hub.ts',
      'apps/server/src/storage/s3.ts',
      'apps/server/src/api.ts',
      'apps/server/test/integration/x.test.ts',
      'apps/server/src/domain/ids.test.ts',
    ]) {
      expect(checkFile(path, 'const id = Bun.randomUUIDv7()\n')).toEqual([])
    }
  })

  test('a guard-allow comment skips the line', () => {
    const text = 'const id = Bun.randomUUIDv7() // guard-allow: one-off migration helper\n'
    expect(checkFile('apps/server/src/domain/users.ts', text)).toEqual([])
  })
})

describe('layer import rules (docs/03 section 3)', () => {
  test('contracts may only depend on zod', () => {
    expect(checkFile('packages/contracts/src/a.ts', "import { z } from 'zod'\n")).toEqual([])
    expect(checkFile('packages/contracts/src/a.ts', "import x from '@chatapp/db'\n")).toHaveLength(
      1,
    )
    expect(checkFile('packages/contracts/src/a.ts', "import x from 'node:crypto'\n")).toHaveLength(
      1,
    )
  })

  test('relative imports may not leave the package', () => {
    const problems = checkFile(
      'packages/contracts/src/a.ts',
      "import x from '../../db/src/schema'\n",
    )
    expect(problems[0]).toContain('leaves its package')
  })

  test('web must not reach db or server', () => {
    expect(checkFile('apps/web/src/a.ts', "import x from '@chatapp/db'\n")).toHaveLength(1)
    expect(checkFile('apps/web/src/a.ts', "import x from '@chatapp/contracts'\n")).toEqual([])
  })

  test('thin server layers must not touch tables', () => {
    expect(
      checkFile('apps/server/src/http/me.ts', "import { eq } from 'drizzle-orm'\n"),
    ).toHaveLength(1)
    expect(
      checkFile('apps/server/src/jobs/email.ts', "import { users } from '@chatapp/db'\n"),
    ).toHaveLength(1)
    expect(checkFile('apps/server/src/domain/me.ts', "import { eq } from 'drizzle-orm'\n")).toEqual(
      [],
    )
  })

  test('domain must not know HTTP, auth SDK or sibling transport layers', () => {
    expect(checkFile('apps/server/src/domain/me.ts', "import { Hono } from 'hono'\n")).toHaveLength(
      1,
    )
    expect(
      checkFile('apps/server/src/domain/me.ts', "import { betterAuth } from 'better-auth'\n"),
    ).toHaveLength(1)
    expect(
      checkFile('apps/server/src/domain/me.ts', "import x from '../http/me.ts'\n"),
    ).toHaveLength(1)
    expect(
      checkFile('apps/server/src/domain/me.ts', "import x from './registration.ts'\n"),
    ).toEqual([])
  })

  test('test files may import the runner but not leave their package', () => {
    expect(
      checkFile('packages/contracts/src/a.test.ts', "import { test } from 'bun:test'\n"),
    ).toEqual([])
    expect(
      checkFile('packages/contracts/src/a.test.ts', "import x from '../../db/src/schema'\n"),
    ).toHaveLength(1)
  })

  test('multi-line imports are matched on their from clause', () => {
    const text = "import {\n  a,\n  b,\n} from 'hono'\n"
    expect(checkFile('apps/server/src/domain/me.ts', text)[0]).toContain(':4:')
  })
})

describe('jsonb columns (D-107)', () => {
  test("Drizzle's jsonb() is refused, jsonbValue is the way", () => {
    const schema = 'packages/db/src/schema/tables.ts'
    expect(
      checkFile(schema, "import { jsonb, pgTable } from 'drizzle-orm/pg-core'\n"),
    ).toHaveLength(1)
    expect(
      checkFile(
        schema,
        "import {\n  integer,\n  jsonb,\n  pgTable,\n} from 'drizzle-orm/pg-core'\n",
      ),
    ).toHaveLength(1)
    expect(
      checkFile('apps/server/src/domain/x.ts', "import { jsonb } from 'drizzle-orm/pg-core'\n"),
    ).toHaveLength(1)
    expect(checkFile(schema, "import { jsonbValue } from './json.ts'\n")).toEqual([])
    expect(
      checkFile(
        'packages/db/src/schema/json.ts',
        "import { customType } from 'drizzle-orm/pg-core'\n",
      ),
    ).toEqual([])
  })
})
