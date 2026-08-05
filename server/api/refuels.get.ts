import { desc, eq, inArray } from 'drizzle-orm'
import { refuelEvents, refuelReceipts } from '../../db/schema'

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
    items: events.map(refuel => ({
      ...refuel,
      receipts: receiptsByRefuel.get(refuel.id) || []
    }))
  }
})
