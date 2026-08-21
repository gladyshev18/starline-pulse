import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { engineSessions, refuelEvents } from '../db/schema'
import { WARM_ENGINE_CELSIUS, idleCost, measureIdleRate, type IdleRate } from '../shared/idle-cost'

// A warm-up is the engine running while the car stays put. What proves it stayed
// put is the odometer: it reports in chunks of ten to twenty kilometres, but it
// always flushes when the ignition goes off, so a session that ends on the same
// reading it started on covered no distance. That makes `is_stationary` the one
// trustworthy movement test here — unlike `warmup_minutes`, which only records
// how long the OBD took to mention the odometer again.
const stationarySessions = (vehicleId: number) => and(
  eq(engineSessions.vehicleId, vehicleId),
  eq(engineSessions.isOpen, false),
  eq(engineSessions.isStationary, true)
)

// The rate is a property of the engine, not of the month being displayed, so it
// is measured over the whole history. A single month rarely holds enough idling
// to outweigh the sensor's own rounding.
export async function measureVehicleIdleRate(database: Database, vehicleId: number) {
  const samples = await database.select({
    durationMinutes: engineSessions.durationMinutes,
    fuelStart: engineSessions.fuelStart,
    fuelEnd: engineSessions.fuelEnd
  }).from(engineSessions).where(stationarySessions(vehicleId))
  return measureIdleRate(samples)
}

export type FuelPriceSource = 'period' | 'latest' | null

// Fuel burned at idle is priced by what the tank it came from cost. Refuels of
// the period itself answer that best; before the first receipt lands there is
// nothing to go on but the most recent price known at the time.
export async function resolveFuelPrice(database: Database, vehicleId: number, start: Date, end: Date) {
  const [period] = await database.select({
    amount: sql<number | null>`sum(${refuelEvents.totalAmount})`,
    litres: sql<number>`coalesce(sum(case when ${refuelEvents.totalAmount} is not null then ${refuelEvents.litresAdded} else 0 end), 0)`
  }).from(refuelEvents).where(and(
    eq(refuelEvents.vehicleId, vehicleId),
    gte(refuelEvents.detectedAt, start),
    lt(refuelEvents.detectedAt, end)
  ))
  const litres = Number(period?.litres || 0)
  if (period?.amount != null && litres > 0) {
    return { pricePerLitre: Number(period.amount) / litres, priceSource: 'period' as FuelPriceSource }
  }

  const latest = await database.query.refuelEvents.findFirst({
    columns: { pricePerLitre: true },
    where: and(
      eq(refuelEvents.vehicleId, vehicleId),
      isNotNull(refuelEvents.pricePerLitre),
      lt(refuelEvents.detectedAt, end)
    ),
    orderBy: desc(refuelEvents.detectedAt)
  })
  if (latest?.pricePerLitre) return { pricePerLitre: latest.pricePerLitre, priceSource: 'latest' as FuelPriceSource }
  return { pricePerLitre: null, priceSource: null as FuelPriceSource }
}

export const emptyIdleSummary = () => ({
  sessions: 0,
  minutes: 0,
  coldSessions: 0,
  coldMinutes: 0,
  warmSessions: 0,
  warmMinutes: 0,
  unknownMinutes: 0,
  litres: 0,
  litresUncertainty: null as number | null,
  cost: null as number | null,
  costUncertainty: null as number | null,
  pricePerLitre: null as number | null,
  priceSource: null as FuelPriceSource,
  rate: {
    litresPerHour: 0,
    uncertaintyLitresPerHour: null,
    source: 'default',
    sessions: 0,
    minutes: 0,
    litres: 0
  } as IdleRate
})

export async function idleSummary(database: Database, vehicleId: number, start: Date, end: Date) {
  const cold = sql`${engineSessions.engineTempStart} < ${WARM_ENGINE_CELSIUS}`
  const warm = sql`${engineSessions.engineTempStart} >= ${WARM_ENGINE_CELSIUS}`
  const [totals] = await database.select({
    sessions: sql<number>`count(*)`,
    minutes: sql<number>`coalesce(sum(${engineSessions.durationMinutes}), 0)`,
    coldSessions: sql<number>`coalesce(sum(case when ${cold} then 1 else 0 end), 0)`,
    coldMinutes: sql<number>`coalesce(sum(case when ${cold} then ${engineSessions.durationMinutes} else 0 end), 0)`,
    warmSessions: sql<number>`coalesce(sum(case when ${warm} then 1 else 0 end), 0)`,
    warmMinutes: sql<number>`coalesce(sum(case when ${warm} then ${engineSessions.durationMinutes} else 0 end), 0)`,
    // Sessions recorded before the coolant reading was stored, and any the
    // backfill could not resolve. They still burned fuel, so they stay in the
    // total and only sit outside the cold/warm split.
    unknownMinutes: sql<number>`coalesce(sum(case when ${engineSessions.engineTempStart} is null then ${engineSessions.durationMinutes} else 0 end), 0)`
  }).from(engineSessions).where(and(
    stationarySessions(vehicleId),
    gte(engineSessions.startedAt, start),
    lt(engineSessions.startedAt, end)
  ))

  const rate = await measureVehicleIdleRate(database, vehicleId)
  const { pricePerLitre, priceSource } = await resolveFuelPrice(database, vehicleId, start, end)
  const minutes = Number(totals?.minutes || 0)

  return {
    ...idleCost({ minutes, rate, pricePerLitre }),
    sessions: Number(totals?.sessions || 0),
    coldSessions: Number(totals?.coldSessions || 0),
    coldMinutes: Number(totals?.coldMinutes || 0),
    warmSessions: Number(totals?.warmSessions || 0),
    warmMinutes: Number(totals?.warmMinutes || 0),
    unknownMinutes: Number(totals?.unknownMinutes || 0),
    pricePerLitre,
    priceSource,
    rate
  }
}
