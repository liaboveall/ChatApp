/** Explicit, reproducible child environment: no ambient process.env, HOME, loader or business variables. */
export function mediaEnvironment(temporaryDirectory: string): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    TMPDIR: temporaryDirectory,
    MALLOC_ARENA_MAX: '2',
    UV_THREADPOOL_SIZE: '1',
    VIPS_CONCURRENCY: '1',
    OMP_NUM_THREADS: '1',
    // Bun 1.4.2 / JSC otherwise sizes deferred GC/JIT pools from the host CPU count.
    // Keep native thread allocation within the container's 64-PID budget, including subprocesses.
    BUN_JSC_numberOfGCMarkers: '1',
    BUN_JSC_numberOfDFGCompilerThreads: '1',
    BUN_JSC_numberOfFTLCompilerThreads: '1',
    BUN_JSC_maxNumberOfWorklistThreads: '1',
  }
}
