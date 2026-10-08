/** Offline inference in the actual Debian worker image, with its production uid and hard cgroup limits. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const image = process.argv[2]
if (!image || !/^[a-z0-9./:_-]+$/.test(image))
  throw new Error('pass the worker image built from the current checkout')
const dir = resolve('.test-runs/m5', `container-${randomUUID()}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
const code = `
import { readFile, stat } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createEmbeddingClient, startEmbeddingChild } from '/app/apps/server/src/runtime/embeddings.ts'
const settings = { enabled: true, name: 'bge', socket: '/run/chatapp-embedding/embedding.sock', cache: '/var/lib/chatapp/models' }
process.env.SOCLAAS_API_KEY = 'PARENT_ONLY_CANARY'
process.env.DATABASE_URL = 'PARENT_ONLY_CANARY'
const child = await startEmbeddingChild(settings), port = createEmbeddingClient(settings), durations = [], rss = []
try {
  let ready = false
  for (let i=0; i<150; i++) {
    try { if ((await fetch('http://embedding.local/health', { unix: settings.socket, signal: AbortSignal.timeout(200) })).ok) { ready=true; break } } catch {}
    await delay(100)
  }
  if (!ready || !child.pid) throw new Error('offline child did not start')
  const env = await readFile('/proc/'+child.pid+'/environ', 'utf8')
  if (env.includes('PARENT_ONLY_CANARY') || env.includes('SOCLAAS_API_KEY=') || env.includes('DATABASE_URL=')) throw new Error('credential inheritance')
  for(let i=0;i<30;i++) {
    const begin = performance.now(), vector = await port.embed(i%5===0 ? '今天记录日常安排。'.repeat(90)+'最后保留历史数据。' : '韩霖负责灰度发布，保留回滚窗口。', 'document')
    if(vector.length!==512 || !vector.every(Number.isFinite)) throw new Error('invalid native result')
    durations.push(performance.now()-begin)
    const status = await readFile('/proc/'+child.pid+'/status','utf8')
    rss.push(Number(/VmHWM:\\s+(\\d+)/.exec(status)?.[1]??0)*1024)
  }
  const architecture = process.arch, os = await readFile('/etc/os-release','utf8')
  const result = { architecture, nativeArm: architecture==='arm64', native: true, debian: os.includes('ID=debian'), uid: process.getuid(), cpuLimit:2,
    childPeakRssBytes: Math.max(...rss), cgroupPeakBytes: Number((await readFile('/sys/fs/cgroup/memory.peak','utf8')).trim()),
    cgroupLimitBytes: Number((await readFile('/sys/fs/cgroup/memory.max','utf8')).trim()), cpuMax: (await readFile('/sys/fs/cgroup/cpu.max','utf8')).trim(),
    p95Ms: durations.sort((a,b)=>a-b)[Math.ceil(durations.length*.95)-1], offline: true, credentialIsolation: true,
    socketMode: (await stat(settings.socket)).mode&0o777, mixedLoad: false, modelVersion: port.modelVersion }
  console.log(JSON.stringify(result))
} finally { await child.stop() }
`
const proc = Bun.spawn(
  [
    'docker',
    'run',
    '--rm',
    '-i',
    '--network=none',
    '--read-only',
    '--memory=1536m',
    '--cpus=2',
    '--pids-limit=128',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m,uid=10001,gid=10001,mode=0700',
    '--tmpfs=/run/chatapp-embedding:rw,nosuid,nodev,noexec,size=4m,uid=10001,gid=10001,mode=0700',
    '--mount',
    `type=bind,src=${resolve('.test-runs/m5/models')},dst=/var/lib/chatapp/models,readonly`,
    image,
    'bun',
    '--no-env-file',
    '-',
  ],
  { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
)
await proc.stdin.write(code)
proc.stdin.end()
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
])
await writeFile(`${dir}/probe.log`, `${stdout}\n${stderr}`, { mode: 0o600 })
if (exitCode !== 0)
  throw new Error(`Debian native probe failed (exit ${exitCode}); see ${dir}/probe.log`)
const result = JSON.parse(stdout.trim()) as Record<string, unknown>
await writeFile(`${dir}/result.json`, `${JSON.stringify({ image, ...result }, null, 2)}\n`, {
  mode: 0o600,
})
console.log(JSON.stringify({ dir, ...result }))
