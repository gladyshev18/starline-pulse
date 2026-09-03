import 'dotenv/config'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import { createDatabase } from '../db/client'
import { refuelReceipts } from '../db/schema'
import { stationByInn } from '../receipts/parsers'
import { applyReceiptsToRefuel } from '../receipts/store'

// Сеть узнаётся по ИНН продавца, но список ИНН пополняется задним числом: чек
// «Воронежнефтепродукта», разобранный до того, как этот ИНН завели, лежит в базе
// без сети — и остаётся так навсегда, потому что второй раз его никто не
// разбирает. На странице заправок такие чеки собираются в отдельную строку
// «Другая АЗС», хотя это та же самая Роснефть, и сравнение сетей врёт.
//
// Скрипт проходит по чекам без сети и проставляет её по ИНН. Прогонять после
// каждого пополнения списка; повторный запуск ничего не меняет.
const apply = process.argv.includes('--apply')
const database = createDatabase()

const rows = await database.select({
  id: refuelReceipts.id,
  purchasedAt: refuelReceipts.purchasedAt,
  sellerInn: refuelReceipts.sellerInn,
  litres: refuelReceipts.litres,
  refuelEventId: refuelReceipts.refuelEventId
}).from(refuelReceipts).where(and(
  isNull(refuelReceipts.station),
  isNotNull(refuelReceipts.sellerInn)
))

const day = (value: Date | null) => value ? value.toISOString().slice(0, 10) : '—'
const events = new Set<number>()
let changed = 0

for (const row of rows) {
  const station = stationByInn(row.sellerInn)
  if (!station) {
    console.log(`чек ${row.id} от ${day(row.purchasedAt)}: ИНН ${row.sellerInn} неизвестен, оставлен без сети`)
    continue
  }
  changed++
  console.log(`чек ${row.id} от ${day(row.purchasedAt)} на ${row.litres ?? '—'} л: ИНН ${row.sellerInn} → ${station}`)
  if (!apply) continue
  await database.update(refuelReceipts)
    .set({ station, updatedAt: new Date() })
    .where(eq(refuelReceipts.id, row.id))
  if (row.refuelEventId != null) events.add(row.refuelEventId)
}

// Заправка берёт сеть у своих чеков, так что исправленный чек надо ей пересчитать —
// иначе на странице заправка останется без сети, хотя её чек уже подписан.
for (const id of events) await applyReceiptsToRefuel(database, id)

console.log(apply
  ? `Готово: ${changed} чеков подписано, ${events.size} заправок пересчитано.`
  : `Нашлось ${changed} чеков из ${rows.length}. Ничего не записано — повторите с --apply.`)
