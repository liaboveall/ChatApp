/**
 * What a composition root hands the domain out of the process configuration (docs/03 section 3). The domain is given the
 * few values it works with and nothing else: not the auth SDK's secret, not connection strings, not storage credentials.
 * Every entry point builds it here, so none of them passes a wider object by accident.
 */
import type { DomainConfig } from '../domain/deps.ts'
import type { Config } from './env.ts'

export function domainConfig(
  config: Config,
  options: {
    /** The model policy without the provider key; only the processes that run or account for the assistant have it. */
    ai?: DomainConfig['ai']
    /** The processes that store or use members' own AI keys also get the key that encrypts them. */
    memberAiKeys?: boolean
  } = {},
): DomainConfig {
  return {
    origin: config.origin,
    timezone: config.timezone,
    auth: {
      tokenEncryptionKey: config.auth.tokenEncryptionKey,
      cursorKey: config.auth.cursorKey,
      restoreEpoch: config.auth.restoreEpoch,
    },
    product: config.product,
    ...(options.ai ? { ai: options.ai } : {}),
    ...(options.memberAiKeys ? { aiKeyEncryptionKey: config.aiKeyEncryptionKey } : {}),
  }
}
