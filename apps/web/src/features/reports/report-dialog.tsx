import {
  type Message,
  REPORT_REASONS,
  reportReceiptSchema,
  reportRequestSchema,
} from '@chatapp/contracts'
import { type FormEvent, useEffect, useState } from 'react'
import { engine, forScreen } from '@/app/sync.ts'
import { Button } from '@/components/ui/button.tsx'
import { Dialog } from '@/components/ui/dialog.tsx'
import { TextAreaField } from '@/components/ui/fields.tsx'
import { api, newIdempotencyKey } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { registerConversationReset, registerStoreReset } from '@/lib/sync/stores.ts'
import { showToast } from '@/lib/toast.ts'
import { m } from '@/paraglide/messages.js'

export const reportReasonLabel = (reason: (typeof REPORT_REASONS)[number]) =>
  ({
    spam: () => m.report_spam(),
    abuse: () => m.report_abuse(),
    illegal: () => m.report_illegal(),
    other: () => m.report_other(),
  })[reason]()
export function ReportDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const [reason, setReason] = useState<(typeof REPORT_REASONS)[number]>('spam'),
    [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const stop = registerStoreReset(onClose)
    const clear = registerConversationReset((id) => {
      if (id === message.conversationId) onClose()
    })
    return () => {
      stop()
      clear()
    }
  }, [message.conversationId, onClose])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || !engine.membershipOf(message.conversationId)) return
    setBusy(true)
    try {
      const input = reportRequestSchema.parse({ messageId: message.id, reason, details })
      const result = await forScreen(message.conversationId, () =>
        api('/api/reports', {
          method: 'POST',
          json: input,
          headers: { 'Idempotency-Key': newIdempotencyKey() },
          schema: reportReceiptSchema,
        }),
      )
      if (result === null) return
      setBusy(false)
      onClose()
      showToast(m.report_sent())
    } catch (error) {
      setBusy(false)
      showToast(describeError(error))
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.report_title()}
      description={m.report_notice()}
    >
      <form className="admin-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span className="field__label">{m.report_reason()}</span>
          <select
            className="input"
            value={reason}
            onChange={(event) =>
              setReason(
                REPORT_REASONS.find((reason) => reason === event.currentTarget.value) ?? 'other',
              )
            }
          >
            {REPORT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reportReasonLabel(reason)}
              </option>
            ))}
          </select>
        </label>
        <TextAreaField
          label={m.report_details()}
          maxLength={1000}
          value={details}
          onChange={(event) => setDetails(event.currentTarget.value)}
        />
        <div className="dialog__actions">
          <Button kind="plain" onClick={onClose}>
            {m.common_cancel()}
          </Button>
          <Button type="submit" busy={busy}>
            {m.report_submit()}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
