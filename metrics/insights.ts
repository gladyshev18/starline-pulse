import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { refuelEvents, refuelReceipts, vehicleSnapshots } from '../db/schema'
import { summariseStarts } from '../shared/engine-starts'
import { summariseInflation } from '../shared/fuel-inflation'
import { summariseOverpay } from '../shared/fuel-overpay'
import { measureDriftTrend } from '../shared/sensor-drift'
import { summariseSeasonality, type SeasonMonth } from '../shared/seasonality'
import { warmupModel } from '../shared/warmup'
import { compareYears, monthRecords, projectYear, yearPace } from '../shared/yearly'
import { emptyTyreOutlook, tyreOutlook } from './tyres'
import { startHealth } from './engine-starts'
import { monthlyTrends } from './monthly'
import { warmupProfile } from './warmup'

// Ночная температура помесячно — та же, что и на карточке месяца, но за всю
// историю разом: сезонности нужен ряд месяцев, а не один.
//
// Ночь берётся с двух до семи: раньше двигатель ещё отдаёт вечернее тепло,
// позже уже встаёт солнце. Минимум за ночь — потому что остатки тепла могут
// только приподнять оценку, но не занизить её.
async function monthlyAmbient(database: Database, vehicleId: number) {
  const rows = await database.all<{ month: string, night: number }>(sql`
    with nights as (
      select
        strftime('%Y-%m', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours') as month,
        strftime('%Y-%m-%d', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours') as day,
        min(${vehicleSnapshots.engineTemp}) as night
      from ${vehicleSnapshots}
      where ${vehicleSnapshots.vehicleId} = ${vehicleId}
        and ${vehicleSnapshots.ignition} = 0
        and ${vehicleSnapshots.engineTemp} is not null
        and cast(strftime('%H', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours') as integer) between 2 and 7
      group by day
    )
    select month, avg(night) as night from nights group by month
  `)
  return new Map(rows.map(row => [String(row.month), Number(row.night)]))
}

// Чеки — единственный источник рублей: и цена литра, и сеть, и день покупки
// известны только из них. Берутся все, а не привязанные к заправкам: чек,
// которому не нашлось события, всё равно знает, почём был литр в тот день.
async function pricedReceipts(database: Database) {
  return database.select({
    purchasedAt: refuelReceipts.purchasedAt,
    station: refuelReceipts.station,
    stationName: refuelReceipts.stationName,
    fuelType: refuelReceipts.fuelType,
    litres: refuelReceipts.litres,
    pricePerLitre: refuelReceipts.pricePerLitre,
    operation: refuelReceipts.operation
  }).from(refuelReceipts).where(and(
    isNotNull(refuelReceipts.pricePerLitre),
    isNotNull(refuelReceipts.purchasedAt)
  )).orderBy(asc(refuelReceipts.purchasedAt))
}

// Заправки, у которых чек подтверждён: только там сравнение датчика с
// действительностью что-то значит.
async function confirmedRefuels(database: Database, vehicleId: number) {
  const events = await database.select({
    id: refuelEvents.id,
    detectedAt: refuelEvents.detectedAt,
    litresAdded: refuelEvents.litresAdded,
    sensorLitresAdded: refuelEvents.sensorLitresAdded,
    percentAfter: refuelEvents.percentAfter
  }).from(refuelEvents).where(eq(refuelEvents.vehicleId, vehicleId)).orderBy(asc(refuelEvents.detectedAt))
  if (!events.length) return []

  const confirming = await database.select({ refuelEventId: refuelReceipts.refuelEventId })
    .from(refuelReceipts).where(and(
      inArray(refuelReceipts.refuelEventId, events.map(event => event.id)),
      inArray(refuelReceipts.matchStatus, ['auto', 'manual'])
    ))
  const confirmed = new Set(confirming.map(row => row.refuelEventId))

  return events.filter(event => confirmed.has(event.id)).map(event => ({
    at: event.detectedAt,
    sensorLitres: event.sensorLitresAdded,
    receiptLitres: event.litresAdded,
    percentAfter: event.percentAfter
  }))
}

export type Insights = Awaited<ReturnType<typeof insights>>

// Всё, что считается не по месяцу, а по всей прожитой истории: тренды,
// зависимости и рекорды. Держать это отдельно от месячной статистики важно —
// окно у них разное, и переключение месяца ничего здесь не меняет.
export async function insights(database: Database, now = new Date()) {
  const vehicle = await database.query.vehicles.findFirst()
  const trends = await monthlyTrends(database, now)
  if (!vehicle) {
    return {
      starts: summariseStarts([]),
      warmup: warmupModel([]),
      overpay: summariseOverpay([]),
      inflation: summariseInflation([]),
      seasonality: summariseSeasonality([]),
      drift: measureDriftTrend([]),
      year: null,
      pace: null,
      comparison: null,
      records: monthRecords([], now),
      months: trends.months,
      tyres: emptyTyreOutlook(now)
    }
  }

  const receipts = await pricedReceipts(database)
  const ambient = await monthlyAmbient(database, vehicle.id)
  const seasonMonths: SeasonMonth[] = trends.months.map(month => ({
    month: month.month,
    celsius: ambient.get(month.month) ?? null,
    consumption: month.consumption,
    distance: month.distance,
    fuelUsed: month.fuelUsed,
    pricePerLitre: month.pricePerLitre
  }))

  return {
    starts: await startHealth(database, vehicle.id, new Date(0), now),
    warmup: await warmupProfile(database, vehicle.id, now),
    overpay: summariseOverpay(receipts.map(receipt => ({ ...receipt, at: receipt.purchasedAt! }))),
    inflation: summariseInflation(receipts.map(receipt => ({ ...receipt, at: receipt.purchasedAt! }))),
    seasonality: summariseSeasonality(seasonMonths),
    drift: measureDriftTrend(await confirmedRefuels(database, vehicle.id)),
    year: projectYear(trends.months, now),
    pace: yearPace(trends.months, now),
    comparison: compareYears(trends.months, now),
    records: monthRecords(trends.months, now),
    months: trends.months,
    // Погода последних месяцев и вывод по шинам. Окно у неё своё, короче
    // остальных: решение про смену принимают по последним неделям, а не по году.
    tyres: await tyreOutlook(database, vehicle.id, now)
  }
}
