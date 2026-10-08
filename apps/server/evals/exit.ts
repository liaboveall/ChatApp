/** CLI success cannot hide a failed full evaluation behind the pending human-review exit code. */
export function evaluationExitCode(input: {
  mock: boolean
  smoke: boolean
  executionError: boolean
  assertionsPass: boolean
  automatedGatesPass: boolean
}): 0 | 1 | 2 {
  if (
    input.executionError ||
    (!input.mock && (!input.assertionsPass || (!input.smoke && !input.automatedGatesPass)))
  )
    return 1
  return input.mock || input.smoke ? 0 : 2
}
