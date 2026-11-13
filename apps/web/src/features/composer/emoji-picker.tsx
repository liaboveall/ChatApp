import { m } from '@/paraglide/messages.js'
import { EMOJI_GROUPS, type EmojiGroupKey } from './emoji.ts'

const GROUP_LABEL: Record<EmojiGroupKey, () => string> = {
  smileys: () => m.emoji_smileys(),
  gestures: () => m.emoji_gestures(),
  nature: () => m.emoji_nature(),
  food: () => m.emoji_food(),
  activity: () => m.emoji_activity(),
  symbols: () => m.emoji_symbols(),
}

/**
 * The emoji of the composer (docs/02 section 3): the ones used last, then a few groups, in one list that scrolls. Each
 * group has its heading, which stays at the top while its rows pass. Picking one writes it into the message.
 */
export function EmojiPicker({
  recent,
  onPick,
}: {
  recent: readonly string[]
  onPick: (emoji: string) => void
}) {
  const groups = [
    ...(recent.length > 0 ? [{ key: 'recent', label: m.emoji_recent(), emoji: recent }] : []),
    ...EMOJI_GROUPS.map((group) => ({
      key: group.key as string,
      label: GROUP_LABEL[group.key](),
      emoji: group.emoji,
    })),
  ]
  return (
    <fieldset className="emoji-picker scroll" aria-label={m.media_emoji()}>
      {groups.map((group) => (
        // biome-ignore lint/a11y/useSemanticElements: a fieldset inside the picker's own fieldset would nest two groups with legends; a labelled group is what this is.
        <div key={group.key} className="emoji-picker__group" role="group" aria-label={group.label}>
          <div className="emoji-picker__title" aria-hidden="true">
            {group.label}
          </div>
          <div className="emoji-picker__grid">
            {group.emoji.map((value) => (
              <button key={value} type="button" onClick={() => onPick(value)}>
                {value}
              </button>
            ))}
          </div>
        </div>
      ))}
    </fieldset>
  )
}
