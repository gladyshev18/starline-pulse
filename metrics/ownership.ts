import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { fixedCosts, serviceDocuments, serviceEvents } from '../db/schema'
import { fixedCostForRange, ownershipCost, serviceCostPerKilometre } from '../shared/ownership'

// Сколько стоило обслуживание, известно не из самой записи о нём, а из
// прикреплённого заказ-наряда: сумму распознаёт OCR и подтверждает человек.
// Документов у одной записи может быть несколько — тогда они складываются.
async function servicePoints(database: Database, vehicleId: number) {
  const rows = await database.select({
    performedAt: serviceEvents.performedAt,
    mileage: serviceEvents.mileage,
    amount: sql<number | null>`sum(${serviceDocuments.totalAmount})`
  }).from(serviceEvents)
    .leftJoin(serviceDocuments, eq(serviceDocuments.serviceEventId, serviceEvents.id))
    .where(eq(serviceEvents.vehicleId, vehicleId))
    .groupBy(serviceEvents.id)

  return rows.map(row => ({
    performedAt: row.performedAt,
    mileage: row.mileage,
    amount: row.amount == null ? null : Number(row.amount)
  }))
}

// Постоянные расходы, пересекающиеся с отрезком. Полис, начавшийся в январе,
// нужен августу — поэтому выбираются не те, что попали в окно целиком, а те,
// что его хотя бы задели.
async function overlappingFixedCosts(database: Database, vehicleId: number, start: Date, end: Date) {
  return await database.select().from(fixedCosts).where(and(
    eq(fixedCosts.vehicleId, vehicleId),
    lt(fixedCosts.startsAt, end),
    gte(fixedCosts.endsAt, start)
  ))
}

// Во что обошёлся километр этого месяца целиком: топливо по балансу бака,
// обслуживание по заказ-нарядам и постоянные расходы теми днями, которыми они
// пересеклись с месяцем.
export async function ownershipSummary(
  database: Database,
  vehicleId: number,
  start: Date,
  end: Date,
  input: { fuelPerKm: number | null, distance: number }
) {
  const service = serviceCostPerKilometre(await servicePoints(database, vehicleId))
  const periods = await overlappingFixedCosts(database, vehicleId, start, end)
  const fixedAmount = fixedCostForRange(periods, start, end)

  return {
    ...ownershipCost({
      fuelPerKm: input.fuelPerKm,
      servicePerKm: service.costPerKm,
      fixedAmount,
      distance: input.distance
    }),
    service,
    fixedAmount,
    // Названия нужны странице: «1019 ₽ постоянных» без расшифровки выглядит
    // как число, взявшееся ниоткуда.
    fixed: periods.map(period => ({
      id: period.id,
      label: period.label,
      kind: period.kind,
      amount: period.amount,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
      share: fixedCostForRange([period], start, end)
    }))
  }
}
