/**
 * Minimal line-preserving reader/writer for .env files, so scripts can fill
 * missing values without touching comments, order or values set by hand.
 */
import { existsSync } from 'node:fs'

export const GENERATED = '<generated>'

export type EnvFile = { path: string; lines: string[] }

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

export async function readEnvFile(path: string): Promise<EnvFile> {
  const text = existsSync(path) ? await Bun.file(path).text() : ''
  return { path, lines: text.split(/\r?\n/) }
}

export function getEnv(file: EnvFile, key: string): string | undefined {
  for (const line of file.lines) {
    const match = LINE.exec(line)
    if (match?.[1] === key) return unquote(match[2] ?? '')
  }
  return undefined
}

export function setEnv(file: EnvFile, key: string, value: string): void {
  const index = file.lines.findIndex((line) => LINE.exec(line)?.[1] === key)
  const next = `${key}=${value}`
  if (index >= 0) file.lines[index] = next
  else file.lines.push(next)
}

export async function writeEnvFile(file: EnvFile): Promise<void> {
  await Bun.write(file.path, `${file.lines.join('\n').replace(/\n+$/, '')}\n`)
}

/** True when a value still needs to be filled in (missing, empty or the <generated> placeholder). */
export function isUnset(value: string | undefined): boolean {
  return value === undefined || value === '' || value === GENERATED
}

function unquote(raw: string): string {
  const value = raw.trim()
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  return quoted && value.length >= 2 ? value.slice(1, -1) : value
}
