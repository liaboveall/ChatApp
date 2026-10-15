/** Explicit opt-in only. The server workspace owns the real-DB harness and its dependencies. */
const run = Bun.spawn(['bun', '--no-env-file', 'apps/server/test/fault/m7-recovery.ts'], {
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exitCode = await run.exited
