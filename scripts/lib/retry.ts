/**
 * Runs `run` again while it fails in a way the caller calls transient, `attempts` times in all. Any other failure, and the
 * failure of the last attempt, is thrown as it is. Used where a fresh try is the remedy (a container engine that
 * misreports a new instance) and a retry must not hide a real fault.
 */
export async function retryWhile<T>(
  attempts: number,
  isTransient: (error: unknown) => boolean,
  run: (attempt: number) => Promise<T>,
  onRetry: (nextAttempt: number, error: unknown) => void = () => undefined,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt)
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error
      onRetry(attempt + 1, error)
    }
  }
}
