import type { OffsiteTarget } from '../storage/conditional.ts'
import { ConfigError } from './env.ts'

/** Explicit opt-in callers choose test or production; ambient test runs must never acquire real offsite writers. */
export function loadOffsiteTarget(
  source: Record<string, string | undefined>,
  group: 'DELETION_JOURNAL' | 'BACKUP',
  mode: 'test' | 'production',
): OffsiteTarget {
  const names = ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'] as const
  const values = names.map((name) => source[`${group}_S3_${name}`])
  const problems = names.flatMap((name, i) =>
    !values[i] || values[i] === '<generated>' ? [`${group}_S3_${name}: required`] : [],
  )
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = values
  try {
    const url = new URL(endpoint ?? '')
    if (url.protocol !== 'https:' || url.origin !== endpoint || url.username || url.password)
      problems.push(`${group}_S3_ENDPOINT: must be a private HTTPS S3 origin`)
    if (endpoint === source.S3_ENDPOINT)
      problems.push(`${group}_S3_ENDPOINT: must be independent of online storage`)
  } catch {
    problems.push(`${group}_S3_ENDPOINT: invalid HTTPS origin`)
  }
  if (mode === 'test' && !bucket?.endsWith('-test'))
    problems.push(`${group}_S3_BUCKET: dedicated test bucket must end in -test`)
  if (mode === 'production' && bucket?.endsWith('-test'))
    problems.push(`${group}_S3_BUCKET: test bucket is not a production target`)
  if (source.DELETION_JOURNAL_S3_BUCKET === source.BACKUP_S3_BUCKET)
    problems.push('DELETION_JOURNAL_S3_BUCKET and BACKUP_S3_BUCKET: must differ')
  if (source.DELETION_JOURNAL_S3_ACCESS_KEY_ID === source.BACKUP_S3_ACCESS_KEY_ID)
    problems.push('DELETION_JOURNAL_S3_ACCESS_KEY_ID and BACKUP_S3_ACCESS_KEY_ID: must differ')
  if (problems.length || !endpoint || !region || !bucket || !accessKeyId || !secretAccessKey)
    throw new ConfigError(problems)
  return { endpoint, region, bucket, accessKeyId, secretAccessKey }
}
