/**
 * The settings of a channel or a group for the people who may change them (docs/01 section 5): name, description and who
 * may add people. The form starts from what the conversation is now and starts over when the conversation changes under
 * it (somebody else saved, or the answer of this save arrived), so it never shows a stale base. The save names the
 * metadata version it was based on; a conflict reloads and says so instead of overwriting the other person.
 */
import { type Conversation, conversationNameSchema, type WhoCanInvite } from '@chatapp/contracts'
import { useState } from 'react'
import { engine } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { Banner } from '@/components/ui/feedback.tsx'
import { SelectField, TextAreaField, TextField } from '@/components/ui/fields.tsx'
import { ApiError } from '@/lib/api.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'
import { patchConversation } from '../conversations/api.ts'
import { inspectorError } from './errors.ts'

function Form({ conversation }: { conversation: Conversation }) {
  const initialName = conversation.name ?? ''
  const initialDescription = conversation.description ?? ''
  const initialInvite: WhoCanInvite = conversation.settings.whoCanInvite ?? 'all_members'
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [invite, setInvite] = useState<WhoCanInvite>(initialInvite)
  const [busy, setBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const nameOk = conversationNameSchema.safeParse(name).success
  const changed =
    name !== initialName || description.trim() !== initialDescription || invite !== initialInvite
  const canSave = changed && nameOk && !busy

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setNameError(null)
    setProblem(null)
    try {
      await patchConversation(conversation.id, {
        expectedMetadataVersion: conversation.metadataVersion,
        ...(name !== initialName ? { name } : {}),
        ...(description.trim() !== initialDescription
          ? { description: description.trim() === '' ? null : description.trim() }
          : {}),
        ...(invite !== initialInvite ? { settings: { whoCanInvite: invite } } : {}),
      })
      showToast(m.inspector_settings_saved())
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.field === 'name') {
        setNameError(m.new_conversation_name_taken())
      } else if (error instanceof ApiError && error.field === 'name') {
        setNameError(m.new_conversation_name_invalid())
      } else if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') {
        // Somebody saved first: the newest version replaces this form (the key changes with it).
        setProblem(m.inspector_settings_stale())
        void engine.refreshConversation(conversation.id)
      } else {
        setProblem(inspectorError(error))
      }
    }
    setBusy(false)
  }

  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {problem !== null ? <Banner tone="danger">{problem}</Banner> : null}
      <TextField
        label={m.inspector_settings_name()}
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={nameError}
        maxLength={200}
        autoComplete="off"
      />
      <TextAreaField
        label={m.inspector_settings_description()}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        maxLength={500}
      />
      <SelectField
        label={m.inspector_settings_invite()}
        value={invite}
        onChange={(event) => setInvite(event.target.value as WhoCanInvite)}
      >
        <option value="all_members">{m.inspector_settings_invite_all()}</option>
        <option value="admins_only">{m.inspector_settings_invite_admins()}</option>
      </SelectField>
      <div>
        <Button type="submit" kind="filled" size="sm" busy={busy} disabled={!canSave}>
          {m.common_save()}
        </Button>
      </div>
    </form>
  )
}

export function SettingsSection({ conversation }: { conversation: Conversation }) {
  return (
    <section className="dsec" aria-labelledby="settings-title">
      <h2 id="settings-title" className="dsec__title">
        {m.inspector_settings_title()}
      </h2>
      {/* A different version of the metadata is a different base: the form starts over with it. */}
      <Form key={conversation.metadataVersion} conversation={conversation} />
    </section>
  )
}
