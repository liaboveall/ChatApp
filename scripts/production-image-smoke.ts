import { dirname, join } from 'node:path'
import {
  privateJson,
  privateWrite,
  runPrivate,
} from '../apps/server/src/runtime/operations-files.ts'
import { releaseManifestSchema } from '../packages/contracts/src/operations.ts'

async function main() {
  const file = process.argv[2]
  if (!file) throw new Error('private release manifest required')
  const manifest = await privateJson(file, releaseManifestSchema, 32 * 1024 * 1024)
  const images = []
  for (const name of ['server', 'media', 'ops']) {
    const id = manifest.images[name]
    if (!id) throw new Error('complete candidate images required')
    const values = JSON.parse(
      await runPrivate(['docker', 'image', 'inspect', id, '--format', '{{json .}}']),
    )
    if (
      values.Config.User !== '10001:10001' ||
      values.Config.Labels?.['chatapp.source-hash'] !== manifest.APPLICATION_SOURCE_HASH ||
      values.Config.Labels?.['org.opencontainers.image.revision'] !== manifest.APPLICATION_SHA ||
      values.Architecture !== (manifest.architecture === 'x64' ? 'amd64' : 'arm64')
    )
      throw new Error('image identity, native architecture or non-root runtime mismatch')
    const output = await runPrivate([
      'docker',
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      '/tmp:size=67108864,mode=1777,nosuid,nodev',
      '--entrypoint',
      'bun',
      id,
      '--no-env-file',
      '-e',
      'const r=await Bun.file("/app/release.json").json();if(process.getuid()!==10001)process.exit(1);console.log(JSON.stringify(r))',
    ])
    const binding = JSON.parse(output)
    if (
      binding.applicationSha !== manifest.APPLICATION_SHA ||
      binding.applicationSourceHash !== manifest.APPLICATION_SOURCE_HASH
    )
      throw new Error('runtime binding differs from archive')
    if (name === 'ops')
      await runPrivate([
        'docker',
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--entrypoint',
        'bun',
        id,
        '--no-env-file',
        '-e',
        "import{lstat}from'node:fs/promises';for(const path of ['/var/lib/chatapp/backup','/var/lib/chatapp/restore']){const s=await lstat(path);if(!s.isDirectory()||(s.mode&0o777)!==0o700||s.uid!==10001||s.gid!==10001)throw Error('private image staging mode or owner mismatch')}for(const args of [['pg_dump','--version'],['pg_restore','--version'],['restic','version'],['bun','--no-env-file','/app/apps/server/src/runtime/operations-cli.ts','help']]){const child=Bun.spawn(args,{stdout:'pipe',stderr:'pipe'});const[out,error,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(code)throw Error('operator binary failed');if(args[0]==='restic'&&!out.startsWith('restic 0.19.1 compiled with go1.27.3'))throw Error('restic compiler binding');console.log(out.trim())}",
      ])
    images.push({ name, id, nativeArchitecture: values.Architecture, uid: 10001 })
  }
  const result = {
    status: 'image_smoke_passed',
    sourceHash: manifest.APPLICATION_SOURCE_HASH,
    images,
    limits:
      'binary startup and image binding only; complete production services and ARM capacity are separate checks',
  }
  await privateWrite(join(dirname(file), 'image-smoke.json'), result)
  console.log(JSON.stringify(result))
}
if (import.meta.main)
  main().catch(() => {
    console.error('image smoke failed; no deployment acceptance claimed')
    process.exitCode = 1
  })
