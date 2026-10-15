import { lstat } from 'node:fs/promises'

try {
  const service = process.argv[2]
  if (service === 'api') {
    const response = await fetch('http://127.0.0.1:3100/api/readyz', {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    })
    process.exit(response.ok ? 0 : 1)
  }
  if (service === 'worker') {
    const { workerHealthStatus } = await import('./process-health.ts')
    const path = process.env.PROCESS_HEALTH_FILE ?? '/tmp/chatapp-worker-health.json'
    if (!/^\/tmp\/chatapp-[a-z-]+\.json$/.test(path)) process.exit(1)
    const info = await lstat(path)
    if (
      !info.isFile() ||
      info.size > 1024 ||
      (info.mode & 0o777) !== 0o600 ||
      info.uid !== process.getuid?.()
    ) {
      console.error('worker_heartbeat_invalid_file')
      process.exit(1)
    }
    const status = workerHealthStatus(await Bun.file(path).json(), Date.now())
    if (status !== 'healthy') console.error(`worker_heartbeat_${status}`)
    process.exit(status === 'healthy' ? 0 : 1)
  }
  process.exit(1)
} catch {
  console.error('healthcheck_unavailable')
  process.exit(1)
}
