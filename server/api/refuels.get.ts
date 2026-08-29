import { desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { refuelEvents, refuelReceipts } from '../../db/schema'
import { standstillFuel } from '../../metrics/standstill-fuel'
import { isReceiptConfirming } from '../../receipts/store'
import { summariseFuelPrices } from '../../shared/fuel-prices'
import { measureSensorDrift } from '../../shared/sensor-drift'
import { measureStandstillFuel } from '../../shared/standstill-fuel'

export default defineEventHandler(async () => {
  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) return {
    items: [],
    drift: measureSensorDrift([]),
    prices: summariseFuelPrices([]),
    standstill: measureStandstillFuel([])
  }

  const events = await database.select()
    .from(refuelEvents)
    .where(eq(refuelEvents.vehicleId, vehicle.id))
    .orderBy(desc(refuelEvents.detectedAt))
    .limit(100)

  const ids = events.map(item => item.id)
  const receipts = ids.length
    ? await database.select().from(refuelReceipts)
      .where(inArray(refuelReceipts.refuelEventId, ids))
      .orderBy(desc(refuelReceipts.createdAt))
    : []
  const receiptsByRefuel = Map.groupBy(receipts, receipt => receipt.refuelEventId)

  // Every refuel a receipt has priced is one measurement of how far the gauge
  // sits from the truth. Alone each is mostly rounding; together they calibrate.
  const drift = measureSensorDrift(events
    .filter(refuel => (receiptsByRefuel.get(refuel.id) || []).some(isReceiptConfirming))
    .map(refuel => ({
      sensorLitres: refuel.sensorLitresAdded,
      receiptLitres: refuel.litresAdded,
      percentAfter: refuel.percentAfter
    })))

  // Цена берётся по всем чекам, а не только по привязанным к этим ста
  // заправкам: чек, которому не нашлось события, всё равно знает, почём был
  // литр в тот день.
  const priced = await database.select({
    purchasedAt: refuelReceipts.purchasedAt,
    station: refuelReceipts.station,
    stationName: refuelReceipts.stationName,
    fuelType: refuelReceipts.fuelType,
    litres: refuelReceipts.litres,
    pricePerLitre: refuelReceipts.pricePerLitre,
    operation: refuelReceipts.operation
  }).from(refuelReceipts).where(isNotNull(refuelReceipts.pricePerLitre))

  return {
    drift,
    prices: summariseFuelPrices(priced),
    // Убыль на стоянке меряется по всей истории: за один месяц ночей набирается
    // полтора десятка, и знака на такой выборке ещё не видно.
    standstill: await standstillFuel(database, vehicle.id, new Date(0), new Date()),
    items: events.map((refuel) => {
      const attached = receiptsByRefuel.get(refuel.id) || []
      const confirming = attached.filter(isReceiptConfirming)
      return {
        ...refuel,
        receipts: attached,
        confirmed: confirming.length > 0,
        receiptTotal: confirming.reduce((total, receipt) => receipt.totalAmount != null ? total + receipt.totalAmount : total, 0) || null,
        // litresAdded already holds the receipt volume once confirmed, so the
        // drift is measured against what the sensor originally reported.
        sensorDrift: confirming.length && refuel.litresAdded != null && refuel.sensorLitresAdded != null
          ? Math.round((refuel.litresAdded - refuel.sensorLitresAdded) * 100) / 100
          : null
      }
    })
  }
})
