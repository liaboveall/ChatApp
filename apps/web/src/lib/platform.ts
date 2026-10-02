/** Platform helpers for keyboard shortcut labels (docs/02 section 7: ⌘ on Apple platforms, Ctrl elsewhere). */

type NavigatorWithData = Navigator & { userAgentData?: { platform?: string } }

export function isApplePlatform(nav: NavigatorWithData = navigator): boolean {
  const platform = nav.userAgentData?.platform ?? nav.platform ?? ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

export type KeyName = 'mod' | 'alt' | 'shift' | string

/** Visible label of one key in a shortcut. */
export function keyLabel(key: KeyName, apple = isApplePlatform()): string {
  switch (key) {
    case 'mod':
      return apple ? '⌘' : 'Ctrl'
    case 'alt':
      return apple ? '⌥' : 'Alt'
    case 'shift':
      return apple ? '⇧' : 'Shift'
    case 'up':
      return '↑'
    case 'down':
      return '↓'
    default:
      return key
  }
}

/** Spoken form for aria-keyshortcuts-style text. */
export function keyName(key: KeyName, apple = isApplePlatform()): string {
  switch (key) {
    case 'mod':
      return apple ? 'Command' : 'Control'
    case 'alt':
      return apple ? 'Option' : 'Alt'
    case 'up':
      return 'Up Arrow'
    case 'down':
      return 'Down Arrow'
    default:
      return key
  }
}
