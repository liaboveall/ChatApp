import type { NoticeWords } from '@/lib/notifications/text.ts'
import { m } from '@/paraglide/messages.js'

/** The words of the centre in the current language; a function so a language change reads them again. */
export const noticeWords = (): NoticeWords => ({
  mention: ({ name, where }) =>
    where === null ? m.notice_mention_dm({ name }) : m.notice_mention({ name, where }),
  reply: ({ name, where }) =>
    where === null ? m.notice_reply_dm({ name }) : m.notice_reply({ name, where }),
  approval: () => m.notice_approval(),
  approvalDone: () => m.notice_approval_done(),
  reminder: () => m.notice_reminder(),
  budget: ({ percent, period }) => m.notice_budget({ percent, period }),
  report: () => m.notice_report(),
  unavailable: () => m.notice_unavailable(),
  withdrawn: () => m.notice_withdrawn(),
  attachment: (kind) => m[`media_excerpt_${kind}`](),
  unnamed: () => m.conversation_unnamed(),
})
