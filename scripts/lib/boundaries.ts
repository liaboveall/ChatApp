/**
 * Architecture boundary rules (docs/03 section 3, D-090), checked on source text so no TypeScript API is needed.
 * `checkFile` is pure: it takes a repo-relative POSIX path and the file text and returns problems.
 */
import { dirname, posix } from 'node:path'

/** Opt-out marker shared with the raw-HTML guard: a line carrying it is skipped. */
const ALLOW = 'guard-allow:'

const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/g

/** Bun-only surface that must stay inside the listed adapters and entry points (D-090). */
const BUN_API = /\bBun\.|(?:from|import)\s*\(?\s*['"](?:bun|bun:[^'"]*|hono\/bun)['"]/

const BUN_ALLOWED: RegExp[] = [
  /^packages\/db\/src\/client\.ts$/,
  /^apps\/server\/src\/runtime\//,
  /^apps\/server\/src\/realtime\/hub(\.ts|\/)/,
  /^apps\/server\/src\/storage\//,
  /^apps\/server\/src\/(api|worker|cli)\.ts$/,
  /^apps\/server\/(test|scripts)\//,
  /^apps\/media\/src\/runtime\//,
  /^apps\/media\/src\/server\.ts$/,
  /^apps\/media\/test\//,
  /^scripts\//,
  /\.test\.ts$/,
]

type Layer = {
  name: string
  /** Does this layer own the file? */
  owns: (path: string) => boolean
  /** Module specifiers that the layer must not import. */
  forbidden: RegExp[]
  why: string
}

const SERVER = 'apps/server/src/'
const THIN_LAYERS = ['http', 'realtime', 'jobs', 'agent/tools']

const LAYERS: Layer[] = [
  {
    name: 'contracts',
    owns: (p) => p.startsWith('packages/contracts/'),
    forbidden: [/^@chatapp\//, /^node:/, /^bun(:|$)/, /^hono/, /^@hono\//, /^drizzle-orm/],
    why: 'packages/contracts depends on nothing but zod and must run in the browser',
  },
  {
    name: 'web',
    owns: (p) => p.startsWith('apps/web/src/'),
    forbidden: [/^@chatapp\/(db|server)/, /^drizzle-orm/, /^node:/, /^bun(:|$)/],
    why: 'browser code must not import packages/db, apps/server, or Node and Bun modules',
  },
  {
    name: 'isolated media',
    owns: (p) => p.startsWith('apps/media/src/'),
    forbidden: [
      /^@chatapp\/(db|server)/,
      /^drizzle-orm/,
      /^better-auth/,
      /^@better-auth\//,
      /^bullmq$/,
      /^ioredis$/,
      /^ai$/,
      /^@ai-sdk\//,
    ],
    why: 'apps/media has no business database, credentials, queue or model access (D-081, D-176)',
  },
  {
    name: 'server media boundary',
    owns: (p) => p.startsWith(SERVER),
    forbidden: [/^sharp(?:\/|$)/, /^thumbhash(?:\/|$)/, /^@chatapp\/media(?:\/|$)/],
    why: 'media decoding belongs exclusively to the isolated media container (D-081)',
  },
  {
    // Vite, Storybook and Playwright configuration, test specs and build tools run in Node and may use it.
    name: 'web tooling',
    owns: (p) => p.startsWith('apps/web/') && !p.startsWith('apps/web/src/'),
    forbidden: [/^@chatapp\/(db|server)/, /^drizzle-orm/],
    why: 'apps/web must not import packages/db or apps/server',
  },
  {
    name: 'server thin layer',
    owns: (p) => THIN_LAYERS.some((dir) => p.startsWith(`${SERVER}${dir}/`)),
    forbidden: [/^drizzle-orm/, /^@chatapp\/db/],
    why: 'http/, realtime/, jobs/ and agent/tools/ must go through domain/ instead of touching tables',
  },
  {
    name: 'domain',
    owns: (p) => p.startsWith(`${SERVER}domain/`),
    forbidden: [/^hono/, /^@hono\//, /^better-auth/, /^@better-auth\//, /^node:(http|https|net)$/],
    why: 'domain/ knows nothing about HTTP, WebSocket or the auth SDK',
  },
]

/** Relative imports of these server directories are forbidden from domain/. */
const DOMAIN_FORBIDDEN_DIRS = ['http', 'realtime', 'jobs', 'auth']

function packageRoot(path: string): string | undefined {
  const match = /^(apps|packages)\/[^/]+\//.exec(path)
  return match?.[0]
}

const PLAIN_JSONB_IMPORT = /import\s*\{[^}]*\bjsonb\b[^}]*\}\s*from\s*['"]drizzle-orm\/pg-core['"]/

export function checkFile(path: string, text: string): string[] {
  const problems: string[] = []
  const lines = text.split('\n')

  // Bun-only API outside the allowed adapters.
  const inScope = /^(apps|packages)\/.+\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)
  if (inScope && !BUN_ALLOWED.some((rule) => rule.test(path))) {
    lines.forEach((line, index) => {
      if (BUN_API.test(line) && !line.includes(ALLOW)) {
        problems.push(
          `${path}:${index + 1}: Bun-specific API outside the allowed adapters/entry points (docs/03 section 3, D-090)`,
        )
      }
    })
  }

  // Drizzle's own jsonb() double-encodes through Bun's driver; jsonb columns are declared with jsonbValue (D-107).
  if (inScope && !/\.test\.ts$/.test(path) && PLAIN_JSONB_IMPORT.test(text)) {
    problems.push(
      `${path}: import jsonbValue from packages/db/src/schema/json.ts instead of Drizzle's jsonb() (docs/12 D-107)`,
    )
  }

  // Test files may use the test runner and fixtures; they only have to stay inside their package.
  const isTest = /\.(test|spec)\.tsx?$/.test(path) || /\/test\//.test(path)
  const layers = isTest ? [] : LAYERS.filter((layer) => layer.owns(path))
  const root = packageRoot(path)
  if (!root) return problems

  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1]
    if (!specifier) continue
    const line = text.slice(0, match.index).split('\n').length
    if (lines[line - 1]?.includes(ALLOW)) continue

    if (specifier.startsWith('.')) {
      const resolved = posix.normalize(posix.join(dirname(path), specifier))
      if (!resolved.startsWith(root)) {
        problems.push(`${path}:${line}: relative import leaves its package (${specifier})`)
        continue
      }
      if (
        path.startsWith(`${SERVER}domain/`) &&
        DOMAIN_FORBIDDEN_DIRS.some((dir) => resolved.startsWith(`${SERVER}${dir}/`))
      ) {
        problems.push(`${path}:${line}: domain/ must not import ${specifier} (docs/03 section 3)`)
      }
      continue
    }

    for (const layer of layers) {
      if (layer.forbidden.some((rule) => rule.test(specifier))) {
        problems.push(
          `${path}:${line}: ${layer.name} must not import "${specifier}" (${layer.why})`,
        )
      }
    }
  }

  return problems
}
