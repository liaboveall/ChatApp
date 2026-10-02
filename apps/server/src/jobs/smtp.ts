/** SMTP delivery with nodemailer: Mailpit locally, Resend's SMTP in production (docs/03 section 2.1). */
import nodemailer from 'nodemailer'
import type { Config } from '../config/index.ts'
import type { Mailer } from '../domain/mail.ts'

export function createSmtpMailer(config: Config['smtp']): Mailer {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // Implicit TLS on 465, opportunistic STARTTLS otherwise (Mailpit speaks plain SMTP locally).
    secure: config.port === 465,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
  return {
    send: async (message) => {
      await transport.sendMail({
        from: config.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        messageId: message.messageId,
      })
    },
  }
}
