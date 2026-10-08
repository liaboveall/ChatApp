/** Read-only environment-file input for this standalone composition root; never writes credentials. */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
export async function readEnvFile(path: string): Promise<{ lines: string[] }> {
  return { lines: existsSync(path) ? (await readFile(path, 'utf8')).split(/\r?\n/) : [] }
}
export function getEnv(file: { lines: string[] }, key: string): string | undefined {
  for (const line of file.lines) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (match?.[1] !== key) continue
    const value = (match[2] ?? '').trim()
    return /^(?:".*"|'.*')$/.test(value) ? value.slice(1, -1) : value
  }
  return undefined
}
