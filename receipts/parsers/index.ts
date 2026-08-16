import { FUEL_TANK_CAPACITY_LITRES } from '../../shared/fuel'
import { completeReceiptAmounts, type ReceiptFields, type ReceiptStation } from '../fields'
import { parseFiscalQr } from '../qr'
import type { ReceiptMailMessage } from '../mail/types'

export type ParsedReceipt = Pick<ReceiptFields,
  'purchasedAt' | 'station' | 'stationName' | 'address' | 'fuelType' |
  'litres' | 'pricePerLitre' | 'totalAmount' | 'fiscalDocNumber' | 'fiscalSign' | 'sellerInn'>

const empty: ParsedReceipt = {
  purchasedAt: null,
  station: null,
  stationName: null,
  address: null,
  fuelType: null,
  litres: null,
  pricePerLitre: null,
  totalAmount: null,
  fiscalDocNumber: null,
  fiscalSign: null,
  sellerInn: null
}

const stationKeywords: [RegExp, ReceiptStation][] = [
  [/роснефт|rosneft|рн-|тнк/i, 'rosneft'],
  [/лукойл|lukoil|ликард/i, 'lukoil']
]

const BLOCK_BREAK = '@@line@@'

// Mail templates wrap markup across source lines, so a label and its value can
// sit in one table row yet several physical lines apart. Only block ends become
// line breaks; every other whitespace run collapses, which keeps one row on one
// line and lets the field parsers work line by line.
export function stripHtml(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, BLOCK_BREAK)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .split(BLOCK_BREAK).map(line => line.trim()).join('\n')
}

function amount(value: string | undefined) {
  if (!value) return null
  const parsed = Number(value.replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : null
}

export function parseReceiptDate(text: string) {
  const match = /(\d{2})\.(\d{2})\.(\d{4})[\s,]*(?:г\.?)?[\s,]*(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (!match) return null
  const [, day, month, year, hour, minute, second] = match
  // Receipts print Moscow time, which is what the rest of the app reports in.
  const moment = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second || 0))
  const date = new Date(moment - 3 * 60 * 60_000)
  return Number.isNaN(date.getTime()) ? null : date
}

// Most OFD letters embed the fiscal check link, which is the same payload the
// paper QR code carries and by far the most reliable part of the message.
export function parseFiscalLink(text: string) {
  const match = /[?&]?(t=\d{8}T\d{4,6}[^\s"'<>]*)/.exec(text)
  return match?.[1] ? parseFiscalQr(match[1]) : null
}

const MIN_FUEL_PRICE = 20
const MAX_FUEL_PRICE = 300
// A refuel cannot exceed the tank; the margin covers filling a nearly dry one.
const MAX_FUEL_LITRES = FUEL_TANK_CAPACITY_LITRES * 1.2

// Fuel lines print as "1. АИ-92-К5 N 2:00000 64.25 20 1285.00" — no units at all,
// so the triple is recognised by the arithmetic: price × volume must equal the
// sum. The pump number and the nozzle code sit in the same line and are rejected
// by that check.
export function parseFuelLineItem(text: string) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const start = lines.findIndex(candidate => /АИ[\s-]?\d{2,3}/i.test(candidate))
  if (start < 0) return null

  // Rosneft prints the grade and the figures on one line; Lukoil puts the amounts
  // on the next one as "41.38 x 61.26 = 2534.94", so the window covers both.
  const line = lines.slice(start, start + 3).join(' ')
  const numbers = [...line.matchAll(/(?<![\d.,:])(\d{1,6}(?:[.,]\d{1,3})?)(?![\d.,]*[:x])/gi)]
    .map(match => Number(match[1]!.replace(',', '.')))
    .filter(value => Number.isFinite(value) && value > 0)

  for (let index = 0; index + 2 < numbers.length; index += 1) {
    const [first, second, total] = [numbers[index]!, numbers[index + 1]!, numbers[index + 2]!]
    if (Math.abs(first * second - total) > 0.05) continue
    // Both factors can look like a price, so the tank is the tie-breaker: no
    // refuel of this car holds more litres than it does. When both readings pass,
    // the printed column order — "Цена за ед. Кол. Сумма" — decides.
    const plausible = (price: number, litres: number) =>
      price >= MIN_FUEL_PRICE && price <= MAX_FUEL_PRICE && litres > 0 && litres <= MAX_FUEL_LITRES
    const assignment = plausible(first, second)
      ? { pricePerLitre: first, litres: second }
      : plausible(second, first) ? { pricePerLitre: second, litres: first } : null
    if (!assignment) continue
    return { ...assignment, totalAmount: Math.round(total * 100) / 100 }
  }
  return null
}

// Mail clients wrap the address across several quoted lines, and the OFD letter
// then prints it a second time without the station number.
function withoutRepeatedTail(value: string) {
  for (let size = Math.floor(value.length / 2); size > 20; size -= 1) {
    const tail = value.slice(-size)
    if (value.slice(0, -size).includes(tail)) return value.slice(0, -size).trim()
  }
  return value
}

export function parseStationAddress(text: string) {
  const lines = text.split(/\r?\n/).map(line => line.replace(/^\s*>\s?/, '').trim())

  // Lukoil labels it "Адрес расчетов" and keeps the whole address on one line;
  // the sender's own e-mail sits under a similar label and must not be taken.
  const labelled = lines.find(line => /^Адрес(\s+расчет[а-яё]*)?\s*:?\s+\S/i.test(line) && !line.includes('@'))
  if (labelled) {
    const value = labelled.replace(/^Адрес(\s+расчет[а-яё]*)?\s*:?\s+/i, '').trim()
    if (value.length > 5) return value.slice(0, 250)
  }

  const start = lines.findIndex(line => /^АЗ[СК]\s*№?\s*\d+/i.test(line))
  if (start < 0) return null

  const block: string[] = []
  for (const line of lines.slice(start)) {
    if (!line) break
    block.push(line)
  }
  const address = withoutRepeatedTail(block.join(' ').replace(/\s+/g, ' ').trim())
  return address.slice(0, 250) || null
}

export function parseReceiptText(text: string): ParsedReceipt {
  const result: ParsedReceipt = { ...empty }

  const fiscal = parseFiscalLink(text)
  if (fiscal) {
    result.purchasedAt = fiscal.purchasedAt
    result.totalAmount = fiscal.totalAmount
    result.fiscalDocNumber = fiscal.fiscalDocNumber
    result.fiscalSign = fiscal.fiscalSign
  }

  const item = parseFuelLineItem(text)
  if (item) {
    result.litres = item.litres
    result.pricePerLitre = item.pricePerLitre
    result.totalAmount ??= item.totalAmount
  }

  result.purchasedAt ||= parseReceiptDate(text)
  result.address ??= parseStationAddress(text)
  // A Cyrillic "л" has no ASCII word boundary after it, so the unit is closed
  // with a lookahead instead of \b.
  result.litres ??= amount(/(\d+[.,]\d{1,3})\s*(?:литр[а-яё]*|л)(?![а-яё])/i.exec(text)?.[1])
  result.pricePerLitre ??= amount(
    /(?:цена|тариф)\D{0,15}(\d+[.,]\d{2})/i.exec(text)?.[1]
    || /(\d+[.,]\d{2})\s*(?:руб\.?|₽|р\.)\s*\/\s*л/i.exec(text)?.[1]
  )
  result.totalAmount ??= amount(
    /(?:итого|итог|к оплате|сумма)\D{0,15}(\d[\d\s]*(?:[.,]\d{2})?)/i.exec(text)?.[1]
  )
  result.fuelType ??= /(АИ[\s-]?\d{2,3}(?:\s+(?:премиум|евро|pulsar|ultimate))?)/i.exec(text)?.[1]
    ?.replace(/^АИ\s?-?\s?/i, 'АИ-') || null
  result.sellerInn ??= /ИНН\D{0,5}(\d{10,12})/i.exec(text)?.[1] || null
  // "Дата выдачи ФД 01.12.2024" sits above the number itself, and "Версия ФФД"
  // ends in the same two letters, so a date and a preceding letter both disqualify.
  result.fiscalDocNumber ??= /(?<![А-ЯЁA-Z])ФД\D{0,5}(\d{1,10})(?![.\d])/i.exec(text)?.[1] || null
  result.fiscalSign ??= /(?:ФП|ФПД)\D{0,5}(\d{6,12})/i.exec(text)?.[1] || null

  for (const [pattern, station] of stationKeywords) {
    if (pattern.test(text)) {
      result.station = station
      break
    }
  }

  return completeReceiptAmounts(result)
}

export function parseReceiptMail(message: ReceiptMailMessage): ParsedReceipt {
  const body = [message.subject, message.text, message.html ? stripHtml(message.html) : '']
    .filter(Boolean).join('\n')
  const parsed = parseReceiptText(body)
  // A letter without its own date is still anchored by when it was delivered.
  parsed.purchasedAt ||= message.date
  return parsed
}

export function parseReceiptAttachment(attachment: { filename: string | null, contentType: string | null, content: Buffer }) {
  const type = attachment.contentType || ''
  if (!type.startsWith('text/')) return null
  return parseReceiptText(stripHtml(attachment.content.toString('utf8')))
}
