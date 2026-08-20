import { eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { imapState, type RefuelReceipt } from '../../db/schema'
import { normalizeReceiptFields } from '../fields'
import { looksLikeFuelReceipt, parseReceiptMail, receiptMailText } from '../parsers'
import { readReceiptQr } from '../qr'
import { createReceipt, findReceiptByContentHash, findReceiptByMessageId } from '../store'
import { receiptContentHash, receiptFileNameFor, saveReceiptFile } from '../storage'
import { createFixtureMailSource } from './fixture'
import { createImapMailSource } from './imap'
import { matchesSenderAllowlist, type ReceiptMailConfig, type ReceiptMailMessage, type ReceiptMailSource } from './types'

export type IngestSummary = {
  fetched: number
  imported: number
  skipped: number
  // Letters from an allowlisted operator that turned out to be about something
  // other than fuel. Kept apart from `skipped` because a rule that drops mail is
  // worth watching: a run that quietly rejects everything is a broken rule.
  notFuel: number
  failed: number
  linked: RefuelReceipt[]
  pending: RefuelReceipt[]
}

// A PDF is the receipt itself; the letter comes next; a bare image is usually the
// QR pixel that OFD letters embed, so it is the last thing worth keeping as the
// document — even though it is the first thing worth reading.
const attachmentPriority = [/^application\/pdf/, /^text\/html/, /^image\//]

export function createMailSource(config: ReceiptMailConfig): ReceiptMailSource | null {
  if (config.mode === 'fixture') return createFixtureMailSource(config)
  if (config.mode === 'live') return createImapMailSource(config)
  return null
}

async function loadState(database: Database, mailbox: string) {
  const [row] = await database.select().from(imapState).where(eq(imapState.mailbox, mailbox)).limit(1)
  return row || null
}

async function saveState(database: Database, mailbox: string, values: { uidValidity: string | null, lastUid: number, lastError: string | null }) {
  const now = new Date()
  const existing = await loadState(database, mailbox)
  if (existing) {
    await database.update(imapState).set({ ...values, lastRunAt: now, updatedAt: now }).where(eq(imapState.id, existing.id))
    return
  }
  await database.insert(imapState).values({ mailbox, ...values, lastRunAt: now })
}

// The letter itself is the document worth keeping when nothing better is
// attached, and it is stored as a file so it opens under the same sandboxed
// download route as an uploaded receipt.
function chooseAttachment(message: ReceiptMailMessage) {
  for (const type of attachmentPriority) {
    const attachment = message.attachments.find(item => type.test(item.contentType || ''))
    if (attachment) return attachment
    if (type.source.includes('html') && message.html) {
      return { filename: 'letter.html', contentType: 'text/html', content: Buffer.from(message.html, 'utf8') }
    }
  }
  return null
}

// Letters that print no fiscal link still carry the QR code as a picture — as an
// attachment from one operator, inlined as a data: URI by another.
function inlineImages(html: string | null) {
  if (!html) return []
  return [...html.matchAll(/data:image\/[a-z+]+;base64,([A-Za-z0-9+/=\s]{100,})/gi)]
    .slice(0, 5)
    .map(match => Buffer.from(match[1]!.replace(/\s/g, ''), 'base64'))
}

async function readMessageQr(message: ReceiptMailMessage) {
  const images = [
    ...message.attachments.filter(item => item.contentType?.startsWith('image/')).map(item => item.content),
    ...inlineImages(message.html)
  ]
  for (const image of images) {
    const fiscal = await readReceiptQr(image)
    if (fiscal) return fiscal
  }
  return null
}

type ImportOutcome = { skipped?: boolean, notFuel?: boolean, receipt?: RefuelReceipt }

async function importMessage(database: Database, message: ReceiptMailMessage, config: ReceiptMailConfig): Promise<ImportOutcome> {
  if (!matchesSenderAllowlist(message.addresses, config.senderAllowlist)) return { skipped: true }
  if (message.messageId && await findReceiptByMessageId(database, message.messageId)) return { skipped: true }

  // The allowlist only vouches for the operator, and an OFD forwards the receipts
  // of every seller alike — a phone bill arrives from the same address as a tank
  // of petrol. Letters about anything else are dropped before they cost storage,
  // but they are counted and named so a real receipt cannot vanish unnoticed.
  const parsed = parseReceiptMail(message)
  if (!looksLikeFuelReceipt(receiptMailText(message), parsed)) {
    return { notFuel: true }
  }

  const attachment = chooseAttachment(message)
  let file = null
  if (attachment) {
    const contentHash = receiptContentHash(attachment.content)
    if (await findReceiptByContentHash(database, contentHash)) return { skipped: true }
    try {
      file = await saveReceiptFile({
        data: attachment.content,
        originalName: receiptFileNameFor(attachment.filename, attachment.contentType || undefined)
      })
    } catch {
      // An attachment the storage refuses must not cost us the parsed figures.
      file = null
    }
  }

  if (parsed.totalAmount == null || parsed.fiscalSign == null) {
    const fiscal = await readMessageQr(message)
    if (fiscal) {
      // The till clock outranks both the delivery time and anything the letter
      // printed, exactly as the fiscal link does when the text carries one.
      parsed.purchasedAt = fiscal.purchasedAt
      parsed.totalAmount ??= fiscal.totalAmount
      parsed.fiscalDocNumber ??= fiscal.fiscalDocNumber
      parsed.fiscalSign ??= fiscal.fiscalSign
    }
  }

  const { receipt } = await createReceipt(database, {
    source: 'imap',
    dataSource: 'parsed',
    externalMessageId: message.messageId,
    file,
    fields: normalizeReceiptFields({ ...parsed, paymentMethod: 'card' })
  })
  return { receipt }
}

export async function ingestReceiptMail(database: Database, config: ReceiptMailConfig, injected?: ReceiptMailSource) {
  const summary: IngestSummary = { fetched: 0, imported: 0, skipped: 0, notFuel: 0, failed: 0, linked: [], pending: [] }
  const source = injected || createMailSource(config)
  if (!source) return summary

  const stored = await loadState(database, config.mailbox)
  const result = await source.fetch({ uidValidity: stored?.uidValidity ?? null, lastUid: stored?.lastUid ?? 0 })
  summary.fetched = result.messages.length

  for (const message of result.messages) {
    try {
      const outcome = await importMessage(database, message, config)
      if (outcome.notFuel) {
        summary.notFuel += 1
        console.info(`Mail uid ${message.uid} is not a fuel receipt: ${message.subject}`)
        continue
      }
      if (outcome.skipped || !outcome.receipt) {
        summary.skipped += 1
        continue
      }
      summary.imported += 1
      if (outcome.receipt.matchStatus === 'auto') summary.linked.push(outcome.receipt)
      else summary.pending.push(outcome.receipt)
    } catch (error) {
      summary.failed += 1
      console.error(`Importing mail uid ${message.uid} failed`, error)
    }
  }

  await saveState(database, config.mailbox, {
    uidValidity: result.uidValidity,
    lastUid: result.lastUid,
    lastError: summary.failed ? `Не удалось разобрать писем: ${summary.failed}` : null
  })
  return summary
}
