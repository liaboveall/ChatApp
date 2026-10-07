import { startMediaServer } from './runtime/supervisor.ts'

// These are image-owned paths, not environment variables, command-line options or IPC fields.
if (import.meta.main) {
  process.umask(0o077)
  try {
    await startMediaServer({
      socketPath: '/run/chatapp-media/media.sock',
      taskEntry: '/app/apps/media/src/runtime/task.ts',
    })
  } catch {
    console.error('media_start_failed')
    process.exit(1)
  }
}
