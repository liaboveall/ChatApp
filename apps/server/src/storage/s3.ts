/** Object storage access (Garage, S3-compatible). Only the readiness probe exists in M1a; uploads arrive in M3. */
import { S3Client } from 'bun'
import type { Config } from '../config/index.ts'

export interface BlobStore {
  /** Resolves when the store answers with valid credentials; rejects otherwise. */
  ping(): Promise<void>
}

export function createBlobStore(config: Config['s3']): BlobStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  })
  return {
    // HEAD of a key that does not exist answers false (not an error) when endpoint, bucket and credentials work.
    ping: async () => {
      await client.exists('.readyz-probe')
    },
  }
}
