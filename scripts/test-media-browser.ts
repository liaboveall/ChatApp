import { withBrowserMedia } from './e2e-media-stack.ts'

await withBrowserMedia(async () => {
  const child = Bun.spawn(
    ['bun', 'run', 'e2e', '--config=playwright.media.config.ts', ...process.argv.slice(2)],
    { cwd: 'apps/web', stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
  )
  const stop = () => child.kill('SIGTERM')
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    process.exitCode = await child.exited
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
})
