import { readFile } from 'node:fs/promises'
import type { MailFetchResult, MailFetchState, ReceiptMailConfig, ReceiptMailSource } from './types'

type FixtureAttachment = { filename?: string, contentType?: string, content?: string, base64?: string }
type FixtureMessage = {
  uid?: number
  messageId?: string
  from?: string
  addresses?: string[]
  subject?: string
  date?: string
  text?: string
  html?: string
  attachments?: FixtureAttachment[]
}

// Mirrors STARLINE_MODE=fixture: the ingest path can be exercised end to end
// without a mailbox, and the same file doubles as the shape of a real message.
export function createFixtureMailSource(config: ReceiptMailConfig): ReceiptMailSource {
  return {
    async fetch(state: MailFetchState): Promise<MailFetchResult> {
      const raw = await readFile(config.fixturePath, 'utf8')
      const parsed = JSON.parse(raw) as { messages?: FixtureMessage[] } | FixtureMessage[]
      const list = Array.isArray(parsed) ? parsed : parsed.messages || []

      const messages = list.map((message, index) => ({
        uid: message.uid ?? index + 1,
        messageId: message.messageId ?? null,
        addresses: message.addresses ?? (message.from ? [message.from] : []),
        subject: message.subject ?? '',
        date: message.date ? new Date(message.date) : new Date(),
        text: message.text ?? '',
        html: message.html ?? null,
        attachments: (message.attachments || []).map(attachment => ({
          filename: attachment.filename ?? null,
          contentType: attachment.contentType ?? null,
          content: Buffer.from(attachment.base64 ?? attachment.content ?? '', attachment.base64 ? 'base64' : 'utf8')
        }))
      })).filter(message => message.uid > state.lastUid).slice(0, config.maxMessages)

      return {
        uidValidity: 'fixture',
        lastUid: messages.reduce((last, message) => Math.max(last, message.uid), state.lastUid),
        messages
      }
    }
  }
}
