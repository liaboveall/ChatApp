/**
 * Reserved names for usernames and display names (docs/01 section 4.3, SEC-14).
 * Comparison always goes through `reservedKey`: NFKC, lower case, no whitespace or zero-width characters.
 * Names that depend on configuration (the agent's username/display name, the product name) are passed in.
 */

export const RESERVED_USERNAMES: readonly string[] = [
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'assistant',
  'agent',
  'bot',
  'api',
  'me',
  'everyone',
  'here',
  'channel',
  'all',
  'owner',
  'official',
  'help',
  'security',
  'staff',
  'moderator',
  'postmaster',
  'abuse',
  'noreply',
  'null',
  'undefined',
]

export const RESERVED_DISPLAY_NAMES: readonly string[] = [
  '助手',
  '系统',
  '管理员',
  '系统管理员',
  '管理',
  '客服',
  '官方',
  '机器人',
  '版主',
  'admin',
  'administrator',
  'system',
  'assistant',
  'agent',
  'bot',
  'support',
  'official',
  'moderator',
]

/** Placeholder usernames given to deleted accounts (INV-11) can never be registered. */
export const DELETED_USERNAME_PREFIX = 'deleted_'

const IGNORED = /[\s\u200B-\u200D\u2060\uFEFF]+/gu

export function reservedKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(IGNORED, '')
}

export function isReservedUsername(username: string, extra: readonly string[] = []): boolean {
  const key = reservedKey(username)
  if (key.startsWith(DELETED_USERNAME_PREFIX)) return true
  return [...RESERVED_USERNAMES, ...extra].some((reserved) => reservedKey(reserved) === key)
}

export function isReservedDisplayName(displayName: string, extra: readonly string[] = []): boolean {
  const key = reservedKey(displayName)
  return [...RESERVED_DISPLAY_NAMES, ...extra].some((reserved) => reservedKey(reserved) === key)
}
