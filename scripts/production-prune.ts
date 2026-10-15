/** Bun's isolated store can contain unlinked lockfile packages. Keep the complete linked runtime graph, including binaries. */
import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

export async function pruneRuntimeStore(root: string, workspaces: string[]) {
  const base = await realpath(root),
    store = join(base, 'node_modules/.bun')
  if (!(await lstat(store)).isDirectory()) throw new Error('isolated dependency store required')
  const visited = new Set<string>(),
    keep = new Set<string>()
  // Optional code-generation peers are linked by Bun even in production. The API/worker/native migrator never build JS.
  const buildOnly = (name: string) => /^(drizzle-kit@|esbuild@|@esbuild[+-])/.test(name)
  async function visitPackage(path: string) {
    const target = await realpath(path)
    if (target !== base && !target.startsWith(`${base}/`))
      throw new Error('dependency escaped build tree')
    if (target.startsWith(`${store}/`)) {
      const name = relative(store, target).split('/')[0]
      if (!name || name === 'node_modules') throw new Error('unexpected isolated dependency layout')
      if (buildOnly(name)) {
        if ((await lstat(path)).isSymbolicLink()) await rm(path)
        return
      }
      keep.add(name)
      await visitModules(join(store, name, 'node_modules'))
    } else await visitModules(join(target, 'node_modules'))
  }
  async function visitModules(directory: string) {
    if (visited.has(directory)) return
    visited.add(directory)
    let entries: string[]
    try {
      entries = await readdir(directory)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
    for (const name of entries.sort()) {
      if (name === '.bun' || name === '.cache') continue
      const path = join(directory, name)
      if (name.startsWith('@')) await visitModules(path)
      else if (name === '.bin') {
        for (const binary of await readdir(path)) {
          if (['esbuild', 'drizzle-kit', 'esr'].includes(binary)) {
            await rm(join(path, binary))
            continue
          }
          const target = await realpath(join(path, binary))
          if (!target.startsWith(`${store}/`)) throw new Error('binary escaped isolated store')
          const key = relative(store, target).split('/')[0]
          if (!key) throw new Error('binary dependency missing')
          if (buildOnly(key)) {
            await rm(join(path, binary))
            continue
          }
          keep.add(key)
          await visitModules(join(store, key, 'node_modules'))
        }
      } else await visitPackage(path)
    }
  }
  for (const workspace of workspaces) {
    const path = resolve(base, workspace, 'node_modules')
    if (!path.startsWith(`${base}/`)) throw new Error('invalid runtime workspace')
    await visitModules(path)
  }
  let removed = 0,
    removedBuildTools = 0
  for (const name of await readdir(store)) {
    if (name === 'node_modules' || keep.has(name)) continue
    if (!(await lstat(join(store, name))).isDirectory()) throw new Error('unexpected store entry')
    await rm(join(store, name), { recursive: true })
    removed++
    if (buildOnly(name)) removedBuildTools++
  }
  return {
    retainedPackages: keep.size,
    removedPackages: removed,
    removedBuildToolPackages: removedBuildTools,
  }
}
if (import.meta.main) {
  if (process.cwd() !== '/app')
    throw new Error('production pruning runs only in the disposable /app image build')
  console.log(
    JSON.stringify(
      await pruneRuntimeStore('/app', [
        'apps/server',
        'apps/media',
        'packages/db',
        'packages/contracts',
      ]),
    ),
  )
}
