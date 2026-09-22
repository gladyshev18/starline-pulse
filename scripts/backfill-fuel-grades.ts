import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { eq, isNotNull } from 'drizzle-orm'
import { createDatabase } from '../db/client'
import { refuelEvents, refuelReceipts } from '../db/schema'
import { parseReceiptText, stripHtml } from '../receipts/parsers'
import { resolveReceiptPath } from '../receipts/storage'
import { applyReceiptsToRefuel } from '../receipts/store'
import { normaliseFuelType } from '../shared/fuel-grades'

// Премиальный бензин до сих пор лежал в базе под именем обычного: разборщик
// брал из строки товара только «АИ-95» и терял фирменное слово — Pulsar,
// ЭКТО Плюс, — которым чек и отличает одно от другого. На графике цены это
// выглядело подорожанием на три рубля за ночь, хотя цена не двигалась: просто
// один раз залили другое топливо.
//
// Скрипт перечитывает сохранённые письма и приводит марку к общему виду.
// Чеки, у которых письма нет (заведённые руками, снимки, PDF), переписать
// неоткуда — у них марка только приводится к общему написанию, а если в ней
// премиальность не отмечена, то и не появится: это придётся поправить в форме.
const apply = process.argv.includes('--apply')
const database = createDatabase()

async function gradeFromFile(storedName: string | null, mimeType: string | null, dataSource: string) {
  // Значения, введённые руками, письмом не перебиваются: человек видел чек,
  // а разборщик — только то, что уцелело в разметке.
  if (dataSource === 'manual' || !storedName || mimeType !== 'text/html') return null
  const text = await readFile(resolveReceiptPath(storedName), 'utf8').catch(() => null)
  return text ? parseReceiptText(stripHtml(text)).fuelType : null
}

const receipts = await database.select({
  id: refuelReceipts.id,
  purchasedAt: refuelReceipts.purchasedAt,
  fuelType: refuelReceipts.fuelType,
  dataSource: refuelReceipts.dataSource,
  pricePerLitre: refuelReceipts.pricePerLitre,
  storedName: refuelReceipts.storedName,
  mimeType: refuelReceipts.mimeType,
  refuelEventId: refuelReceipts.refuelEventId
}).from(refuelReceipts).where(isNotNull(refuelReceipts.fuelType))

const day = (value: Date | null) => value ? value.toISOString().slice(0, 10) : '—'
const events = new Set<number>()
let changed = 0

for (const receipt of receipts) {
  const fromFile = await gradeFromFile(receipt.storedName, receipt.mimeType, receipt.dataSource)
  const fuelType = fromFile ?? normaliseFuelType(receipt.fuelType)
  if (!fuelType || fuelType === receipt.fuelType) continue
  changed++
  console.log(`чек ${receipt.id} от ${day(receipt.purchasedAt)} по ${receipt.pricePerLitre ?? '—'} ₽/л: ${receipt.fuelType} → ${fuelType}`)
  if (!apply) continue
  await database.update(refuelReceipts)
    .set({ fuelType, updatedAt: new Date() })
    .where(eq(refuelReceipts.id, receipt.id))
  if (receipt.refuelEventId != null) events.add(receipt.refuelEventId)
}

// Заправка берёт марку у своих чеков, но у заправки без чеков она своя,
// вписанная руками, — её тоже надо привести к общему написанию.
const refuels = await database.select({
  id: refuelEvents.id,
  detectedAt: refuelEvents.detectedAt,
  fuelType: refuelEvents.fuelType
}).from(refuelEvents).where(isNotNull(refuelEvents.fuelType))

let refuelsChanged = 0
for (const refuel of refuels) {
  if (events.has(refuel.id)) continue
  const fuelType = normaliseFuelType(refuel.fuelType)
  if (!fuelType || fuelType === refuel.fuelType) continue
  refuelsChanged++
  console.log(`заправка ${refuel.id} от ${day(refuel.detectedAt)}: ${refuel.fuelType} → ${fuelType}`)
  if (!apply) continue
  await database.update(refuelEvents).set({ fuelType }).where(eq(refuelEvents.id, refuel.id))
}

for (const id of events) await applyReceiptsToRefuel(database, id)

console.log(apply
  ? `Готово: ${changed} чеков и ${refuelsChanged} заправок исправлено, ${events.size} заправок пересчитано.`
  : `Нашлось ${changed} чеков и ${refuelsChanged} заправок. Ничего не записано — повторите с --apply.`)
