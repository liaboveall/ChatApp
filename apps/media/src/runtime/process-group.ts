import { type ChildProcess, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { mediaEnvironment } from './environment.ts'
import { CleanupError, hasErrorCode } from './files.ts'

export type TaskExit = {
  code: number | null
  signal: NodeJS.Signals | null
  failedToStart: boolean
}
export type TaskProcess = {
  child: ChildProcess
  exited: Promise<TaskExit>
  termination?: Promise<void>
  terminated?: boolean
}

export function spawnTask(taskEntry: string, directory: string): TaskProcess {
  const child = spawn(process.execPath, ['--no-env-file', taskEntry, directory], {
    detached: true,
    shell: false,
    cwd: directory,
    env: mediaEnvironment(directory),
    stdio: 'ignore',
  })
  const exited = new Promise<TaskExit>((resolve) => {
    child.once('error', () => resolve({ code: null, signal: null, failedToStart: true }))
    child.once('exit', (code, signal) => resolve({ code, signal, failedToStart: false }))
  })
  return { child, exited }
}

export function killTaskGroup(task: TaskProcess): void {
  if (task.terminated) return
  const pid = task.child.pid
  if (pid === undefined) return
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new CleanupError()
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if (!hasErrorCode(error, 'ESRCH')) throw new CleanupError()
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return false
    throw new CleanupError()
  }
}

/** Reap the leader and prove the entire group is gone, even after a successful leader exit. */
export function terminateTask(task: TaskProcess): Promise<void> {
  if (task.termination) return task.termination
  task.termination = (async () => {
    killTaskGroup(task)
    const deadline = performance.now() + 2000
    let exited = false
    void task.exited.then(() => {
      exited = true
    })
    while (!exited || (task.child.pid !== undefined && groupExists(task.child.pid))) {
      if (performance.now() >= deadline) throw new CleanupError()
      killTaskGroup(task)
      await delay(10)
    }
    task.terminated = true
  })()
  return task.termination
}
