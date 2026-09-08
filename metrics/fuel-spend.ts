import { and, asc, eq, gte, lt } from 'drizzle-orm'
import type { Database } from '../db/client'
import { refuelEvents } from '../db/schema'
import { summariseFuelSpend, type FuelSpend } from '../shared/fuel-spend'

export const emptyFuelSpend = (): FuelSpend => summariseFuelSpend([])

// Заправок за месяц — единицы, поэтому строки забираются целиком и складываются
// в JS: так суммировать умеет и помесячная сводка, которой те же строки нужны
// разложенными по месяцам, а не свёрнутыми в одно число.
export async function fuelSpend(database: Database, vehicleId: number, start: Date, end?: Date) {
  const rows = await database.select({
    litresAdded: refuelEvents.litresAdded,
    totalAmount: refuelEvents.totalAmount
  }).from(refuelEvents).where(and(
    eq(refuelEvents.vehicleId, vehicleId),
    gte(refuelEvents.detectedAt, start),
    ...(end ? [lt(refuelEvents.detectedAt, end)] : [])
  )).orderBy(asc(refuelEvents.detectedAt))

  return summariseFuelSpend(rows)
}
