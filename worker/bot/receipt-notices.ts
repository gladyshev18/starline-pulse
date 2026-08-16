import type { RefuelReceipt } from '../../db/schema'
import type { IngestSummary } from '../../receipts/mail/ingest'

const decimal = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' })
const moment = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' })

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function describe(receipt: RefuelReceipt) {
  return escapeHtml([
    receipt.purchasedAt ? moment.format(receipt.purchasedAt) : 'без даты',
    receipt.litres != null ? `${decimal.format(receipt.litres)} л` : null,
    receipt.totalAmount != null ? money.format(receipt.totalAmount) : null
  ].filter(Boolean).join(' · '))
}

// A quiet run is the normal outcome and deserves no message at all.
export function buildReceiptImportNotice(summary: IngestSummary) {
  if (!summary.linked.length && !summary.pending.length) return null

  const lines = ['🧾 <b>Чеки из почты</b>', '']
  if (summary.linked.length) {
    lines.push(`Привязано к заправкам: ${summary.linked.length}`)
    lines.push(...summary.linked.slice(0, 5).map(receipt => `• ${describe(receipt)}`))
  }
  if (summary.pending.length) {
    if (summary.linked.length) lines.push('')
    lines.push(`Ждут решения: ${summary.pending.length}`)
    lines.push(...summary.pending.slice(0, 5).map(receipt => `• ${describe(receipt)}`))
    lines.push('', 'Откройте раздел «Чеки», чтобы выбрать заправку.')
  }
  return lines.join('\n')
}
