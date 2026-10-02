import { type Config, loadConfig } from '../../src/config/index.ts'

let cached: Config | undefined

/** Configuration for integration tests: APP_ENV=test with the *_TEST targets, validated like production code. */
export function testConfig(): Config {
  if (process.env.APP_ENV !== 'test') throw new Error('integration tests require APP_ENV=test')
  cached ??= loadConfig(process.env)
  return cached
}
