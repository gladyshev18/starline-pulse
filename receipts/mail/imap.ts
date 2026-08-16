import { MAX_RECEIPT_SIZE } from '../storage'
import { normalizeMailAddress, parseForwardedSenders, type MailFetchResult, type MailFetchState, type ReceiptMailConfig, type ReceiptMailMessage, type ReceiptMailSource } from './types'

type ParsedMail = Awaited<ReturnType<typeof import('mailparser')['simpleParser']>>

function addressesOf(parsed: ParsedMail) {
  const headers = ['from', 'sender', 'reply-to', 'return-path', 'x-forwarded-for', 'x-original-from'] as const
  const found = headers.flatMap((header) => {
    const value = parsed.headers.get(header)
    if (!value) return []
    if (typeof value === 'string') return [value]
    const list = value as { value?: { address?: string }[], text?: string }
    return list.value?.map(item => item.address || '') ?? (list.text ? [list.text] : [])
  })
  return [...new Set(found.map(normalizeMailAddress).filter((value): value is string => value != null))]
}

export function createImapMailSource(config: ReceiptMailConfig): ReceiptMailSource {
  return {
    async fetch(state: MailFetchState): Promise<MailFetchResult> {
      const { ImapFlow } = await import('imapflow')
      const { simpleParser } = await import('mailparser')

      const client = new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: { user: config.user, pass: config.password },
        proxy: config.proxyUrl || undefined,
        logger: false,
        // Credentials must never reach the job log that the app shows.
        emitLogs: false
      })

      const messages: ReceiptMailMessage[] = []
      let lastUid = state.lastUid
      let uidValidity: string | null = null

      await client.connect()
      try {
        const mailbox = await client.mailboxOpen(config.mailbox)
        uidValidity = mailbox.uidValidity.toString()
        // A new UIDVALIDITY means the server renumbered everything, so the old
        // watermark is meaningless and the window falls back to the date range.
        const restart = state.uidValidity != null && state.uidValidity !== uidValidity
        const from = restart || !state.lastUid ? 1 : state.lastUid + 1
        const since = new Date(Date.now() - config.sinceDays * 24 * 60 * 60_000)

        const uids = await client.search({ since, uid: `${from}:*` }, { uid: true }) || []
        for (const uid of uids.slice(-config.maxMessages)) {
          const downloaded = await client.download(String(uid), undefined, { uid: true })
          if (!downloaded?.content) continue
          const parsed = await simpleParser(downloaded.content, { maxHtmlLengthToParse: 2 * 1024 * 1024 })

          const text = parsed.text || ''
          messages.push({
            uid,
            messageId: parsed.messageId || null,
            addresses: [...new Set([...addressesOf(parsed), ...parseForwardedSenders(text)])],
            subject: parsed.subject || '',
            date: parsed.date || new Date(),
            text,
            html: typeof parsed.html === 'string' ? parsed.html : null,
            attachments: (parsed.attachments || [])
              .filter(attachment => attachment.content.length > 0 && attachment.content.length <= MAX_RECEIPT_SIZE)
              .map(attachment => ({
                filename: attachment.filename || null,
                contentType: attachment.contentType || null,
                content: attachment.content
              }))
          })
          lastUid = Math.max(lastUid, uid)
        }

        if (config.markSeen && messages.length) {
          await client.messageFlagsAdd(messages.map(message => String(message.uid)).join(','), ['\\Seen'], { uid: true })
        }
      } finally {
        await client.logout().catch(() => client.close())
      }

      return { uidValidity, lastUid, messages }
    }
  }
}
