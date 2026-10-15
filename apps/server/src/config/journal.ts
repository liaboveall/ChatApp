import { z } from 'zod'
import type { OffsiteTarget } from '../storage/conditional.ts'
import { ConfigError } from './env.ts'
import { loadOffsiteTarget } from './offsite.ts'

export type JournalSettings = {
  target: OffsiteTarget
  prefix: string
  writerEpoch: string
  keyringFile: string
}
export function loadJournalSettings(
  source: Record<string, string | undefined>,
): JournalSettings | undefined {
  if (!['true', 'false', undefined, ''].includes(source.DELETION_JOURNAL_ENABLED))
    throw new ConfigError(['DELETION_JOURNAL_ENABLED: must be true or false'])
  const enabled = source.DELETION_JOURNAL_ENABLED === 'true'
  if (!enabled) {
    if (source.APP_ENV === 'production')
      throw new ConfigError([
        'DELETION_JOURNAL_ENABLED: independent deletion journal required in production',
      ])
    return undefined
  }
  // Ordinary test commands do not gain an offsite writer from the developer's .env.local.
  if (source.APP_ENV === 'test')
    throw new ConfigError([
      'DELETION_JOURNAL_ENABLED: real writers are forbidden in ordinary tests; use the isolated M7 harness',
    ])
  const target = loadOffsiteTarget(
    source,
    'DELETION_JOURNAL',
    source.APP_ENV === 'production' ? 'production' : 'test',
  )
  const prefix = source.DELETION_JOURNAL_PREFIX
  const writerEpoch = source.DELETION_JOURNAL_WRITER_EPOCH
  const keyringFile = source.DELETION_JOURNAL_KEYRING_FILE
  const problems: string[] = []
  if (!prefix || !/^[A-Za-z0-9_/-]+\/$/.test(prefix) || prefix.includes('..'))
    problems.push('DELETION_JOURNAL_PREFIX: required safe namespace ending in /')
  if (!z.uuid().safeParse(writerEpoch).success)
    problems.push('DELETION_JOURNAL_WRITER_EPOCH: required UUID')
  if (!keyringFile)
    problems.push('DELETION_JOURNAL_KEYRING_FILE: required separate recovery keyring')
  if (problems.length || !prefix || !writerEpoch || !keyringFile) throw new ConfigError(problems)
  return { target, prefix, writerEpoch, keyringFile }
}
