import { desc, eq, inArray } from 'drizzle-orm'
import { refuelEvents, refuelReceipts } from '../../db/schema'
import { isReceiptConfirming } from '../../receipts/store'

export default defineEventHandler(async () => {
  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) return { items: [] }

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

  return {
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
