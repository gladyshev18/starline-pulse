export type ReceiptMailAttachment = {
  filename: string | null
  contentType: string | null
  content: Buffer
}

export type ReceiptMailMessage = {
  uid: number
  messageId: string | null
  addresses: string[]
  subject: string
  date: Date
  text: string
  html: string | null
  attachments: ReceiptMailAttachment[]
}

export type ReceiptMailConfig = {
  mode: 'off' | 'fixture' | 'live'
  fixturePath: string
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  mailbox: string
  senderAllowlist: string[]
  sinceDays: number
  maxMessages: number
  pollMinutes: number
  proxyUrl: string
  markSeen: boolean
}

export type MailFetchState = {
  uidValidity: string | null
  lastUid: number
}

export type MailFetchResult = {
  uidValidity: string | null
  lastUid: number
  messages: ReceiptMailMessage[]
}

export interface ReceiptMailSource {
  fetch(state: MailFetchState): Promise<MailFetchResult>
}

function addressDomain(address: string) {
  return address.slice(address.lastIndexOf('@') + 1)
}

export function normalizeMailAddress(value: string | null | undefined) {
  const address = value?.trim().toLowerCase().replace(/^.*<|>.*$/g, '').trim()
  return address && address.includes('@') ? address : null
}

// Hand-forwarding from Mail.ru or Outlook rewrites every header and leaves the
// original sender only in the quoted block the client pastes on top of the body.
export function parseForwardedSenders(text: string) {
  const found = [...text.slice(0, 4000).matchAll(/^\s*>?\s*(?:От|From)\s*:\s*(.+)$/gmi)]
    .map(match => normalizeMailAddress(match[1]))
  return [...new Set(found.filter((value): value is string => value != null))]
}

// Forwarding keeps the original From on Gmail and Yandex, but rewrites the
// envelope sender, so every address the message carries gets a look.
export function matchesSenderAllowlist(addresses: string[], allowlist: string[]) {
  if (!allowlist.length) return false
  const senders = addresses.map(normalizeMailAddress).filter((value): value is string => value != null)
  return senders.some(sender => allowlist.some((entry) => {
    const rule = entry.trim().toLowerCase().replace(/^@/, '')
    if (!rule) return false
    if (rule.includes('@')) return sender === rule
    const domain = addressDomain(sender)
    return domain === rule || domain.endsWith(`.${rule}`)
  }))
}
