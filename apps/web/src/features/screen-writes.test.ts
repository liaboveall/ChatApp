/**
 * The writes a screen makes (D-174). What a screen does when the answer to its request comes back (jump to what the request
 * made, say what was done, end the session) is for the person who made the request: by then somebody else may be signed
 * in, in the same page. Every write goes through `forScreen`, which answers null when that person is not here any more,
 * and the screen has to look at the answer. This test reads the sources of the screens and refuses what would bring the
 * old problem back:
 *
 *  1. a request that changes something, made from a screen without going through `forScreen`;
 *  2. a `useMutation` whose `mutationFn` does not go through it (its callbacks run whoever is in front of the screen);
 *  3. one of the writes of `conversations/api.ts`, awaited with its answer thrown away: the screen cannot have asked
 *     whether the person who made the request is still here.
 *
 * It is a reading of the code, not a proof: it cannot tell a null that is handled badly from one that is handled well.
 * The browser tests of `late-effects.spec.ts` do that for the screens they cover. (TypeScript 7 is a native compiler and has no
 * JavaScript API to read a source file with, so the sources are read with the Babel parser the build already carries.)
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from '@babel/core'
import { describe, expect, test } from 'vitest'

type Node = {
  type: string
  start?: number
  end?: number
  loc?: { start: { line: number } }
} & Record<string, unknown>

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCANNED = ['features', 'routes', 'app']
const WRAPPERS = new Set(['forScreen', 'conversationWrite'])
const WRITE_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'PUT'])
/** Requests of the account that the page makes for something other than a screen's answer, and why they may go without. */
const EXEMPT: Record<string, string> = {
  'features/auth/auth-api.ts':
    'anonymous requests: nobody is signed in, so there is no person to protect (the one that is not, `changePassword`, is wrapped where it is called)',
  'features/settings/use-auto-timezone.ts':
    'nothing follows on a screen; the answer only updates the identity it was made for (D-171)',
  'features/message-actions/actions.ts':
    'every one takes its own ticket and words its failures through the engine (D-171, D-173)',
  'app/sync.ts': 'the outbox of unsent messages carries its own ticket (D-171)',
}
/** Writes in name only: a POST that reads. */
const READ_BY_POST = new Set(['previewInvite'])
/** Helpers of other modules that make a write for a screen; where they are called they have to be wrapped too. */
const WRITE_HELPERS = new Set(['addPasskey', 'renamePasskey', 'deletePasskey'])

function parse(code: string, filename: string): Node {
  const ast = parseSync(code, {
    babelrc: false,
    configFile: false,
    filename,
    sourceType: 'module',
    parserOpts: { plugins: ['typescript', 'jsx'] },
  })
  if (ast === null) throw new Error(`cannot read ${filename}`)
  return ast as unknown as Node
}

function walk(
  node: unknown,
  visit: (node: Node, ancestors: Node[]) => void,
  ancestors: Node[] = [],
): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, ancestors)
    return
  }
  if (node === null || typeof node !== 'object') return
  const current = node as Node
  if (typeof current.type !== 'string') return
  visit(current, ancestors)
  const next = [...ancestors, current]
  for (const [key, value] of Object.entries(current)) {
    if (key === 'loc' || key === 'extra' || key.endsWith('Comments')) continue
    walk(value, visit, next)
  }
}

const nameOf = (node: unknown): string | undefined => {
  const n = node as Node | undefined
  return n?.type === 'Identifier' ? (n.name as string) : undefined
}

/** `authApi.changePassword`-style callee as a dotted name. */
function calleeName(callee: unknown): string | undefined {
  const c = callee as Node
  if (c.type === 'Identifier') return c.name as string
  if (c.type === 'MemberExpression' && !c.computed) {
    const object = nameOf(c.object)
    const property = nameOf(c.property)
    return object !== undefined && property !== undefined ? `${object}.${property}` : undefined
  }
  return undefined
}

const isCallOf = (node: Node, names: ReadonlySet<string>): boolean =>
  node.type === 'CallExpression' && names.has(calleeName(node.callee) ?? '')

const wrapped = (ancestors: Node[]): boolean => ancestors.some((a) => isCallOf(a, WRAPPERS))

function property(object: Node, key: string): Node | undefined {
  return (object.properties as Node[]).find(
    (p) => p.type === 'ObjectProperty' && (nameOf(p.key) === key || (p.key as Node).value === key),
  )
}

/** Whether a call of `api` sends something that changes: a method other than GET, or a body. */
function changesSomething(call: Node): boolean {
  const options = (call.arguments as Node[])[1]
  if (options === undefined || options.type !== 'ObjectExpression') return false
  if (property(options, 'json') !== undefined) return true
  const method = property(options, 'method')?.value as Node | undefined
  return method?.type === 'StringLiteral' && WRITE_METHODS.has(method.value as string)
}

/** The writes of `conversations/api.ts`: what is exported there and goes through the wrapper. */
function screenWritesOf(code: string): Set<string> {
  const names = new Set<string>()
  for (const statement of (parse(code, 'api.ts').program as unknown as { body: Node[] }).body) {
    if (statement.type !== 'ExportNamedDeclaration') continue
    const declaration = statement.declaration as Node | null
    if (declaration?.type !== 'VariableDeclaration') continue
    for (const declarator of declaration.declarations as Node[]) {
      const text = code.slice(declarator.start, declarator.end)
      const name = nameOf(declarator.id)
      if (name !== undefined && /\b(forScreen|conversationWrite)\(/.test(text)) names.add(name)
    }
  }
  return names
}

/** What in this file brings the old problem back; each entry says where and what. */
function violationsOf(
  code: string,
  file: string,
  writes: ReadonlySet<string>,
  exempt = false,
): string[] {
  const found: string[] = []
  const where = (node: Node): string => `${file}:${node.loc?.start.line ?? '?'}`
  walk(parse(code, file), (node, ancestors) => {
    if (!exempt && node.type === 'CallExpression') {
      const name = calleeName(node.callee)
      const insideRead = ancestors.some(
        (a) => a.type === 'VariableDeclarator' && READ_BY_POST.has(nameOf(a.id) ?? ''),
      )
      if (name === 'api' && changesSomething(node) && !wrapped(ancestors) && !insideRead) {
        found.push(`${where(node)}: a request that changes something does not go through forScreen`)
      }
      if (
        (WRITE_HELPERS.has(name ?? '') || name === 'authApi.changePassword') &&
        !wrapped(ancestors)
      ) {
        found.push(`${where(node)}: ${name} is called without forScreen`)
      }
      if (name === 'useMutation') {
        const options = (node.arguments as Node[])[0]
        const fn =
          options?.type === 'ObjectExpression' ? property(options, 'mutationFn') : undefined
        let through = false
        walk(fn?.value, (inner) => {
          if (isCallOf(inner, WRAPPERS)) through = true
        })
        if (!through)
          found.push(
            `${where(node)}: the mutationFn of a useMutation does not go through forScreen`,
          )
      }
    }
    if (
      node.type === 'ExpressionStatement' &&
      (node.expression as Node).type === 'AwaitExpression' &&
      ((node.expression as Node).argument as Node).type === 'CallExpression' &&
      writes.has(calleeName(((node.expression as Node).argument as Node).callee) ?? '')
    ) {
      found.push(`${where(node)}: the answer of a write is thrown away (ask whether it is null)`)
    }
  })
  return found
}

function sources(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|stories)\.tsx?$/.test(entry.name))
      out.push(path)
  }
  return out
}

describe('the checker itself', () => {
  const none = new Set<string>()

  test('refuses a request that changes something without the wrapper, and accepts one inside it', () => {
    const bad = "async function f() { await api('/api/x', { method: 'POST' }) }"
    const bodyOnly = "async function f() { await api('/api/x', { json: {} }) }"
    const good =
      "async function f() { await forScreen(null, () => api('/api/x', { method: 'POST' })) }"
    expect(violationsOf(bad, 'a.ts', none)).toHaveLength(1)
    expect(violationsOf(bodyOnly, 'a.ts', none)).toHaveLength(1)
    expect(violationsOf(good, 'a.ts', none)).toHaveLength(0)
    expect(violationsOf("api('/api/x')", 'a.ts', none)).toHaveLength(0)
    expect(violationsOf(bad, 'a.ts', none, true)).toHaveLength(0)
  })

  test('a mutationFn has to go through the wrapper', () => {
    expect(
      violationsOf('useMutation({ mutationFn: () => doIt(), onSuccess: () => {} })', 'a.tsx', none),
    ).toHaveLength(1)
    expect(
      violationsOf(
        'useMutation({ mutationFn: () => forScreen(null, () => doIt()) })',
        'a.tsx',
        none,
      ),
    ).toHaveLength(0)
  })

  test('the helpers that write for a screen are wrapped where they are called', () => {
    expect(violationsOf('addPasskey()', 'a.ts', none)).toHaveLength(1)
    expect(violationsOf('authApi.changePassword({})', 'a.ts', none)).toHaveLength(1)
    expect(violationsOf('forScreen(null, () => addPasskey())', 'a.ts', none)).toHaveLength(0)
  })

  test('the answer of a write is looked at', () => {
    const writes = new Set(['liftBan'])
    expect(violationsOf('async function f() { await liftBan(1) }', 'a.ts', writes)).toHaveLength(1)
    expect(
      violationsOf(
        'async function f() { if ((await liftBan(1)) === null) return }',
        'a.ts',
        writes,
      ),
    ).toHaveLength(0)
    expect(
      violationsOf('async function f() { const x = await liftBan(1) }', 'a.ts', writes),
    ).toHaveLength(0)
  })

  test('finds the writes of the conversation API by the wrapper they go through', () => {
    const code = `
      export const a = (id) => forScreen(id, () => api('/x'))
      export const b = (id) => conversationWrite(id, () => api('/y'))
      export const c = (id) => api('/z')
      export async function d() {}
    `
    expect([...screenWritesOf(code)].sort()).toEqual(['a', 'b'])
  })
})

describe('the screens of the application', () => {
  const writes = screenWritesOf(readFileSync(join(SRC, 'features/conversations/api.ts'), 'utf8'))

  test('there are writes to guard', () => {
    expect(writes.size).toBeGreaterThan(10)
    expect(writes.has('leaveConversation')).toBe(true)
  })

  test('every write goes through forScreen and its answer is looked at', () => {
    const problems: string[] = []
    for (const directory of SCANNED) {
      for (const path of sources(join(SRC, directory))) {
        const file = relative(SRC, path).split('\\').join('/')
        problems.push(...violationsOf(readFileSync(path, 'utf8'), file, writes, file in EXEMPT))
      }
    }
    expect(problems).toEqual([])
  })

  test('what is exempt exists, and is not wrapped for nothing', () => {
    for (const file of Object.keys(EXEMPT)) {
      expect(() => readFileSync(join(SRC, file), 'utf8')).not.toThrow()
    }
  })
})
