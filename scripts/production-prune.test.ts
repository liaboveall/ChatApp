import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneRuntimeStore } from './production-prune.ts'

test('pruning preserves transitive dependencies, workspace links, cycles and executable-only dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-graph-'))
  const store = join(root, 'node_modules/.bun')
  try {
    for (const name of ['a', 'b', 'cli', 'unlinked-build-tool', 'esbuild@old']) {
      await mkdir(join(store, name, 'node_modules', name), { recursive: true })
      await writeFile(join(store, name, 'node_modules', name, 'index.js'), '')
    }
    await mkdir(join(root, 'apps/server/node_modules/.bin'), { recursive: true })
    await symlink(join(store, 'a/node_modules/a'), join(root, 'apps/server/node_modules/a'))
    await symlink(join(store, 'b/node_modules/b'), join(store, 'a/node_modules/b'))
    await symlink(join(store, 'a/node_modules/a'), join(store, 'b/node_modules/a'))
    await symlink(
      join(store, 'esbuild@old/node_modules/esbuild@old'),
      join(store, 'a/node_modules/esbuild'),
    )
    await symlink(
      join(store, 'esbuild@old/node_modules/esbuild@old/index.js'),
      join(root, 'apps/server/node_modules/.bin/esbuild'),
    )
    await symlink(
      join(store, 'cli/node_modules/cli/index.js'),
      join(root, 'apps/server/node_modules/.bin/cli'),
    )
    expect(await pruneRuntimeStore(root, ['apps/server', 'packages/not-present'])).toEqual({
      retainedPackages: 3,
      removedPackages: 2,
      removedBuildToolPackages: 1,
    })
    expect((await readdir(store)).sort()).toEqual(['a', 'b', 'cli'])
    await symlink('/etc', join(root, 'apps/server/node_modules/outside'))
    await expect(pruneRuntimeStore(root, ['apps/server'])).rejects.toThrow('escaped')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
