/**
 * My own settings for one conversation (docs/01 section 4.4): pin it to the top of the list, mute its notifications for a
 * while or for good, and hide a direct message. These belong to the person, not the conversation, so everybody who is in
 * it sees them, whatever their role. They are conditional on the viewer version the person last saw (D-082): after a
 * conflict the conversation is read again and the person tries once more.
 */

import type { Conversation } from '@chatapp/contracts'
import { useNavigate } from '@tanstack/react-router'
import { EyeOff } from 'lucide-react'
import { useId, useState } from 'react'
import { engine } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { Switch } from '@/components/ui/controls.tsx'
import { SelectField } from '@/components/ui/fields.tsx'
import { ApiError } from '@/lib/api.ts'
import { serverNow } from '@/lib/realtime.ts'
import { dateTime } from '@/lib/time-format.ts'
import { showToast } from '@/lib/toast.ts'
import { useTime } from '@/lib/use-time.ts'
import { m } from '@/paraglide/messages.js'
import { patchMyState } from '../conversations/api.ts'
import { inspectorError } from './errors.ts'
import { MUTE_CHOICES, type MuteChoice, muteFromChoice, muteSelection } from './presets.ts'

const muteLabel = (choice: MuteChoice): string => {
  switch (choice) {
    case 'off':
      return m.inspector_mute_off()
    case '1h':
      return m.inspector_mute_1h()
    case '8h':
      return m.inspector_mute_8h()
    case '1d':
      return m.inspector_mute_1d()
    case '7d':
      return m.inspector_mute_7d()
    case 'forever':
      return m.inspector_mute_forever()
  }
}

export function MySettingsSection({ conversation }: { conversation: Conversation }) {
  const me = conversation.me
  const pinLabel = useId()
  const navigate = useNavigate()
  const { locale, timeZone } = useTime()
  const [busy, setBusy] = useState(false)
  if (me === null) return null

  const change = async (
    request: Parameters<typeof patchMyState>[1],
    after?: () => void,
  ): Promise<void> => {
    setBusy(true)
    try {
      // Null: the person who asked, or the membership it was about, is not here any more (D-174); nothing follows.
      if ((await patchMyState(conversation.id, request)) !== null) after?.()
    } catch (error) {
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        void engine.refreshConversation(conversation.id)
      }
      showToast(inspectorError(error))
    }
    setBusy(false)
  }

  const selection = muteSelection(me.mute, serverNow())
  return (
    <section className="dsec" aria-labelledby="my-title">
      <h2 id="my-title" className="dsec__title">
        {m.inspector_my_title()}
      </h2>
      <div className="dsec__row">
        <span id={pinLabel} className="text-callout">
          {m.inspector_pin()}
        </span>
        <Switch
          checked={me.pinnedAt !== null}
          labelledBy={pinLabel}
          disabled={busy}
          onCheckedChange={(pinned) => void change({ expectedViewerVersion: me.version, pinned })}
        />
      </div>
      <SelectField
        label={m.inspector_mute()}
        value={selection}
        disabled={busy}
        onChange={(event) => {
          const choice = event.target.value as MuteChoice | 'until'
          if (choice === 'until') return
          void change({
            expectedViewerVersion: me.version,
            mute: muteFromChoice(choice, serverNow()),
          })
        }}
      >
        {selection === 'until' && me.mute.mode === 'until' ? (
          <option value="until">
            {m.inspector_mute_until({ when: dateTime(me.mute.until, locale, timeZone) })}
          </option>
        ) : null}
        {MUTE_CHOICES.map((choice) => (
          <option key={choice} value={choice}>
            {muteLabel(choice)}
          </option>
        ))}
      </SelectField>
      {conversation.kind === 'dm' ? (
        <div className="dsec__row dsec__row--stack">
          <Button
            kind="plain"
            size="sm"
            icon={EyeOff}
            busy={busy}
            onClick={() =>
              void change({ expectedViewerVersion: me.version, hidden: true }, () => {
                showToast(m.inspector_hidden())
                void navigate({ to: '/' })
              })
            }
          >
            {m.inspector_hide_dm()}
          </Button>
          <span className="dsec__note">{m.inspector_hide_dm_help()}</span>
        </div>
      ) : null}
    </section>
  )
}
